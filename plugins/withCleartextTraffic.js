/**
 * Lets the app talk to a server over plain http.
 *
 * DEV-STAGE. This must be scoped before release — see below.
 *
 * An Audiobookshelf server on a home network is reached at something like
 * `http://192.168.1.90:13378`, and since API 28 Android refuses cleartext by
 * default. The refusal happens in the socket layer, so what the app sees is
 * an indistinguishable transport failure: the connect form can only say "could
 * not reach the server", which is exactly the wrong diagnosis and sends the
 * person off checking their wiring.
 *
 * `android.usesCleartextTraffic` is **not** a key Expo's app config
 * understands. Setting it there alone does nothing — `expo config` will
 * happily echo it back, because unknown keys survive the merge, and the
 * generated manifest will not contain it. This plugin is what makes the key
 * mean something, so the flag can still live in app.json where a reader
 * would look for it.
 *
 * **Before release:** replace this with a network security config that
 * permits cleartext only for private address ranges — 10/8, 172.16/12,
 * 192.168/16, 169.254/16 and localhost — so a LAN server keeps working while
 * a password can never leave the house in clear. Tracked in docs/STATE.md
 * under the Audiobookshelf section.
 */

const { withAndroidManifest } = require('expo/config-plugins');

const withCleartextTraffic = (config) => {
  // Driven by the app config rather than hardcoded, so turning it off is an
  // edit to app.json and not a hunt through plugins/.
  const wanted = config.android?.usesCleartextTraffic === true;

  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      // Nothing to attach it to. Loud, because a silent miss here is the
      // whole reason this plugin exists.
      console.warn('[withCleartextTraffic] no <application> tag in the manifest');
      return modConfig;
    }

    if (wanted) application.$['android:usesCleartextTraffic'] = 'true';
    else delete application.$['android:usesCleartextTraffic'];

    return modConfig;
  });
};

module.exports = withCleartextTraffic;
