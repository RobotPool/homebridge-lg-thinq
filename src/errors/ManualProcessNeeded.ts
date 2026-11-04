// Modified by the RobotPool maintainers (https://github.com/RobotPool/homebridge-lg-thinq):
// see NOTICE and the git history for the changes made to this file.
export const ManualProcessNeededErrorCode = '0110';

export const ManualProcessNeededMessage = 'LG account needs attention (result code 0110): LG has new terms or notices '
  + 'for this account. Open the LG ThinQ app, sign out and sign in again, accept what it shows, then restart Homebridge.';

export class ManualProcessNeeded extends Error {}
