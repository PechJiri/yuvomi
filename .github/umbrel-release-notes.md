<!-- version: 2.57.3 -->
This is a maintenance release focused on Yuvomi's setup wizard - the guided installer used for manual Docker installations. Since Umbrel installs and updates Yuvomi through the app store, existing households are not affected by these changes and will notice nothing new in day-to-day use.

For anyone who does run the wizard, it became considerably more forgiving: a page reload no longer silently discards everything entered, typos in the timezone or SMTP port are caught immediately instead of surfacing weeks later, error messages appear right at the field they belong to, and the review screen now works properly on phones and after switching languages. Several accessibility gaps for keyboard and screen-reader users were closed as well.

The update needs nothing from you and applies no database change.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.57.3
