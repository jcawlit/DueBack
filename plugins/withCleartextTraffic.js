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
 * **This used to say "replace with a network security config scoped to
 * private address ranges before release". That cannot be written.**
 * `usesCleartextTraffic` is all or nothing, and a network security config's
 * `<domain>` takes a hostname or an IP literal — there is no subnet syntax —
 * so "http is fine on 192.168/16" is not a thing the manifest can say when
 * the address is one the listener types in at runtime.
 *
 * So it is enforced in the app, at the one place every server request passes
 * through: `isCleartextToPublicHost` in `src/lib/abs/client.ts` refuses any
 * plain-http request to an address outside the private ranges, loopback and
 * the LAN naming conventions, before it is sent. A LAN server keeps working;
 * a password cannot leave the house in clear.
 *
 * The flag staying on is therefore deliberate rather than deferred. What it
 * permits is cleartext *in principle*; what the app will actually send is
 * narrower, and that is where the rule can be expressed at all.
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
