const path = require('path');
const fs = require('fs');
const https = require('follow-redirects').https;

const semver = require('semver');
const marked = require('marked');

class ModuleQuery {
  constructor({dirname, modulePath, sources = ['local', 'npm']} = {}) {
    this.dirname = dirname;
    this.modulePath = modulePath;
    this.sources = sources;
  }

  search(q = '', {keywords = [], includeScoped = false, includeDeprecated = false} = {}) {
    const {dirname, modulePath, sources} = this;

    const _requestAllLocalModules = () => new Promise((accept, reject) => {
      if (modulePath) {
        fs.readdir(path.join(dirname, modulePath), (err, files) => {
          if (!err || err.code === 'ENOENT') {
            files = files || [];

            if (files.length > 0) {
              const result = [];
              let pending = files.length;
              const pend = () => {
                if (--pending === 0) {
                  accept(result.sort((a, b) => path.basename(a).localeCompare(path.basename(b))));
                }
              };

              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const filePath = path.join(modulePath, file);

                fs.lstat(path.join(dirname, filePath), (err, stats) => {
                  if (!err) {
                    if (stats.isDirectory()) {
                      result.push(filePath.replace(/\\/g, '/'));
                    }
                  } else {
                    console.warn(err);
                  }

                  pend();
                });
              }
            } else {
              accept([]);
            }
          } else {
            reject(err);
          }
        });
      } else {
        accept([]);
      }
    });
    const _getModules = mods => Promise.all(mods.map(mod => this.getModule(mod)));
    const _requestLocalModules = q => {
      if (sources.includes('local')) {
        return _requestAllLocalModules()
          .then(modules => modules.filter(module => {
            const name = path.basename(module);
            return name.indexOf(q) !== -1;
          }))
          .then(_getModules);
      } else {
        return Promise.resolve([]);
      }
    };
    const _requestNpmModules = q => {
      if (sources.includes('npm')) {
        return new Promise((accept, reject) => {
          const _rejectApiError = _makeRejectApiError(reject);

          https.get({
            hostname: 'registry.npmjs.org',
            path: '/-/v1/search?text=' + encodeURIComponent(q) + (keywords.length > 0 ? ('+keywords:' + keywords.join(',')) : '')
            ,
          }, proxyRes => {
            if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
              _getResponseJson(proxyRes, (err, j) => {
                if (!err) {
                  if (typeof j === 'object' && j !== null) {
                    const {objects} = j;

                    if (Array.isArray(objects)) {
                      const mods = objects.map(({package: {name}}) => name);
                      accept(mods);
                    } else {
                      _rejectApiError();
                    }
                  } else {
                    _rejectApiError();
                  }
                } else {
                  _rejectApiError(500, err.stack);
                }
              });
            } else {
              _rejectApiError(proxyRes.statusCode);
            }
          }).on('error', err => {
            _rejectApiError(500, err.stack);
          });
        })
        .then(moduleNames => {
          if (!includeScoped) {
            moduleNames = moduleNames.filter(moduleName => !/^@/.test(moduleName));
          }
          return moduleNames;
        })
        .then(_getModules)
        .then(moduleSpecs => {
          if (!includeDeprecated) {
            moduleSpecs = moduleSpecs.filter(moduleSpec => !moduleSpec.deprecated);
          }
          return moduleSpecs;
        });
      } else {
        return Promise.resolve([]);
      }
    };

    return Promise.all([
      _requestLocalModules(q),
      _requestNpmModules(q),
    ])
      .then(([
        localModSpecs,
        npmModSpecs,
      ]) => {
        const index = {};
        for (let i = 0; i < localModSpecs.length; i++) {
          index[localModSpecs[i].name] = true;
        }

        const result = localModSpecs.slice();
        for (let i = 0; i < npmModSpecs.length; i++) {
          const npmModSpec = npmModSpecs[i];
          if (!index[npmModSpec.name]) {
            result.push(npmModSpec);
          }
        }
        return Promise.resolve(result);
      });
  }

  getModule(mod) {
    const {dirname, modulePath} = this;

    const _getModulePackageJson = plugin => {
      const _getLocalModulePackageJson = plugin => new Promise((accept, reject) => {
        if (dirname) {
          fs.readFile(path.join(dirname, plugin, 'package.json'), 'utf8', (err, s) => {
            if (!err) {
              const j = _jsonParse(s);

              if (j !== null) {
                accept(j);
              } else {
                const err = new Error('Failed to parse package.json for ' + JSON.stringify(plugin));
                reject(err);
              }
            } else {
              reject(err);
            }
          });
        } else {
          const err = new Error('Not found');
          reject(err);
        }
      });
      const _getNpmModulePackageJson = module => new Promise((accept, reject) => {
        const _rejectApiError = _makeRejectApiError(reject);

        https.get({
          hostname: 'unpkg.com',
          path: '/' + module + '/package.json',
        }, proxyRes => {
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            _getResponseJson(proxyRes, (err, j) => {
              if (!err) {
                if (typeof j === 'object' && j !== null) {
                  accept(j);
                } else {
                  _rejectApiError();
                }
              } else {
                _rejectApiError(proxyRes.statusCode);
              }
            });
          } else {
            _rejectApiError(proxyRes.statusCode);
          }
        }).on('error', err => {
          _rejectApiError(500, err.stack);
        });
      });

      if (path.isAbsolute(plugin)) {
        return _getLocalModulePackageJson(plugin);
      } else {
        return _getNpmModulePackageJson(plugin);
      }
    };
    const _getModuleDetails = plugin => {
      const _getLocalModuleDetails = plugin => new Promise((accept, reject) => {
        if (dirname) {
          fs.readFile(path.join(dirname, plugin, 'package.json'), 'utf8', (err, s) => {
            if (!err) {
              const j = _jsonParse(s);

              if (j !== null) {
                const {version = '0.0.1'} = j;
                const author = null;
                const versions = [version];
                const deprecated = false;

                accept({
                  author,
                  versions,
                  deprecated,
                });
              } else {
                reject(new Error('Failed to parse package.json for ' + JSON.stringify(plugin)));
              }
            } else {
              reject(err);
            }
          });
        } else {
          reject(new Error('Not found'));
        }
      });
      const _getNpmModuleDetails = module => new Promise((accept, reject) => {
        const _rejectApiError = _makeRejectApiError(reject);

        https.get({
          hostname: 'registry.npmjs.org',
          path: '/' + module,
        }, proxyRes => {
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            _getResponseJson(proxyRes, (err, j) => {
              if (!err) {
                if (typeof j === 'object' && j !== null && typeof j.maintainers === 'object' && typeof j.versions === 'object' && j.versions !== null) {
                  const author = j.maintainers[0].name;
                  const versions = Object.keys(j.versions).sort((a, b) => semver.compare(a, b) * - 1); // newest to oldest
                  const deprecated = Boolean(j.versions[versions[0]].deprecated);

                  accept({
                    author,
                    versions,
                    deprecated,
                  });
                } else {
                  _rejectApiError();
                }
              } else {
                _rejectApiError(proxyRes.statusCode);
              }
            });
          } else {
            _rejectApiError(proxyRes.statusCode);
          }
        }).on('error', err => {
          _rejectApiError(500, err.stack);
        });
      });

      if (path.isAbsolute(plugin)) {
        return _getLocalModuleDetails(plugin);
      } else {
        return _getNpmModuleDetails(plugin);
      }
    };
    const _getModuleReadme = plugin => {
      const _getLocalModuleReadme = module => new Promise((accept, reject) => {
        if (dirname && modulePath && plugin.indexOf(modulePath.replace(/\\/g, '/')) === 0) {
          fs.readFile(path.join(dirname, plugin, 'README.md'), 'utf8', (err, s) => {
            if (!err) {
              accept(s);
            } else if (err.code === 'ENOENT') {
              accept(null);
            } else {
              reject(err);
            }
          });
        } else {
          const err = new Error('Invalid local module path: ' + JSON.stringify(plugin));
          reject(err);
        }
      });
      const _getNpmModuleReadme = module => new Promise((accept, reject) => {
        const _rejectApiError = _makeRejectApiError(reject);

        https.get({
          hostname: 'unpkg.com',
          path: '/' + module + '/README.md',
        }, proxyRes => {
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            _getResponseString(proxyRes, (err, s) => {
              if (!err) {
                accept(s);
              } else {
                _rejectApiError(proxyRes.statusCode);
              }
            });
          } else if (proxyRes.statusCode === 404) {
            accept(null);
          } else {
            _rejectApiError(proxyRes.statusCode);
          }
        }).on('error', err => {
          _rejectApiError(500, err.stack);
        });
      });

      if (path.isAbsolute(plugin)) {
        return _getLocalModuleReadme(plugin);
      } else {
        return _getNpmModuleReadme(plugin);
      }
    };

    return Promise.all([
      _getModulePackageJson(mod),
      _getModuleDetails(mod),
      _getModuleReadme(mod),
    ])
      .then(([
        packageJson,
        {
          author,
          versions,
          deprecated,
        },
        readme,
      ]) => ({
        type: 'module',
        id: packageJson.name,
        name: packageJson.name,
        displayName: packageJson.name,
        author: author,
        version: packageJson.version,
        versions: versions,
        description: packageJson.description || null,
        readme: readme ? marked(readme) : null,
        serves: packageJson.serves || null,
        builds: packageJson.builds || null,
        metadata: packageJson.metadata || null,
        hasClient: Boolean(packageJson.client),
        hasServer: Boolean(packageJson.server),
        hasWorker: Boolean(packageJson.worker),
        local: path.isAbsolute(mod),
        deprecated: deprecated,
      }));
  }
}

const _jsonParse = s => {
  let error = null;
  let result;
  try {
    result = JSON.parse(s);
  } catch (err) {
    error = err;
  }
  if (!error) {
    return result;
  } else {
    return null;
  }
};
const _makeRejectApiError = reject => (statusCode = 500, message = 'API Error: ' + statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  reject(err); 
};
const _getResponseBuffer = (res, cb) => {
  const bs = [];

  res.on('data', d => {
    bs.push(d);
  });
  res.on('end', () => {
    cb(null, Buffer.concat(bs));
  });
  res.on('error', err => {
    cb(err);
  });
};
const _getResponseString = (res, cb) => {
  _getResponseBuffer(res, (err, b) => {
    if (!err) {
      cb(null, b.toString('utf8'));
    } else {
      cb(err);
    }
  });
};
const _getResponseJson = (res, cb) => {
  _getResponseString(res, (err, s) => {
    if (!err) {
      cb(null, _jsonParse(s));
    } else {
      cb(err);
    }
  });
};
/* const _renderMarkdown = s => showdownConverter
  .makeHtml(s)
  .replace(/&mdash;/g, '-')
  .replace(/(<code\s*[^>]*?>)([^>]*?)(<\/code>)/g, (all, start, mid, end) => start + mid.replace(/\n/g, '<br/>') + end)
  .replace(/\n+/g, ' '); */

const _makeModuleQuery = opts => new ModuleQuery(opts);
module.exports = _makeModuleQuery;
