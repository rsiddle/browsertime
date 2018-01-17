'use strict';

const BrowserError = require('../../support/errors').BrowserError;
const remove = require('lodash.remove');
const harBuilder = require('../../support/harBuilder');

class FirefoxDelegate {
  constructor({ skipHar = false, firefox = {} }) {
    this.skipHar = skipHar;
    this.firefox = firefox;
  }

  async onStartRun() {
    this.index = 1;
    this.hars = [];
  }

  async onStartIteration() {}

  async onStopIteration(runner) {
    if (this.skipHar) {
      return;
    }
    let har;
    if (this.firefox.useLegacyHar) {
      const script = `
            var callback = arguments[arguments.length - 1];
            function triggerExport() {
              HAR.triggerExport({'token':'test', 'getData':true})
                .then((result) => {
                  // Fix timings via performance.timing, see https://github.com/firebug/har-export-trigger/issues/5
                  var har = JSON.parse(result.data);
                  var t = performance.timing;
                  var pageTimings = har.log.pages[0].pageTimings;
                  pageTimings.onContentLoad = t.domContentLoadedEventStart - t.navigationStart;
                  pageTimings.onLoad = t.loadEventStart - t.navigationStart;
                  har.log.pages[0].title = document.title;
                  return callback({'har': JSON.stringify(har)});
              })
              .catch((e) => callback({'error': e}));
            };
            if (typeof HAR === 'undefined') {
              addEventListener('har-api-ready', triggerExport, false);
            } else {
              triggerExport();
            }`;

      const harResult = await runner.runAsyncScript(
        script,
        'GET_HAR_LEGACY_SCRIPT'
      );
      if (harResult.error) {
        throw new BrowserError('Error in Firefox HAR generation', {
          cause: harResult.error
        });
      }
      har = JSON.parse(harResult.har);
    } else {
      const script = `
      (function(win) {
        if (typeof win.HAR == 'undefined') {
          let id = 0;
          let callsInProgress = new Map();

          win.HAR = {
            triggerExport: function(options) {
              return new window.Promise(function(resolve) {
                let actionId = ++id;
                callsInProgress.set(actionId, resolve);

                let event = new window.CustomEvent('HAR.triggerExport', {
                  detail: {
                    actionId: actionId,
                    options: options
                  }
                });

                document.dispatchEvent(event);
              });
            }
          };

          // Response event handlers
          document.addEventListener('HAR.triggerExport-Response', function(
            event
          ) {
            let { actionId, harLog } = event.detail;
            harLog = JSON.parse(harLog);
            let resolve = callsInProgress.get(actionId);
            if (resolve) {
              callsInProgress.delete(actionId);
              resolve(harLog);
            } else {
              console.log('HAR API: Unknown HAR response!', event);
            }
          });
        }
      })(window);

      return HAR.triggerExport();
      `;
      const harResult = await runner.runAsyncScript(script, 'GET_HAR_SCRIPT');
      // TODO check for an empty HAR
      har = JSON.parse(harResult);
    }

    har.log.pages[0].title += ' run ' + this.index;

    // Firefox inlude entries in the HAR that are from the local cache
    // and adds them with a time of 0.
    // lets remove them.
    remove(har.log.entries, function(entry) {
      return entry.time === 0;
    });
    this.hars.push(har);
    this.index++;
  }

  async onStopRun(result) {
    if (!this.skipHar && this.hars.length > 0) {
      result.har = harBuilder.mergeHars(this.hars);
    }
  }
}

module.exports = FirefoxDelegate;
