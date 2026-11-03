// Modified by the RobotPool maintainers (https://github.com/RobotPool/homebridge-lg-thinq):
// see NOTICE and the git history for the changes made to this file.
/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'LGThinQ';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = '@robotpool/homebridge-lg-thinq';

/**
 * Directory under the Homebridge storage path for the device and MQTT caches.
 * Kept at the original package name so caches survive a switch between the
 * upstream package and this one.
 */
export const STORAGE_DIR_NAME = 'homebridge-lg-thinq';
