<!-- version: 2.57.4 -->
This is a small bugfix release. It fixes a case where opening a page directly by its address - a bookmark to the calendar, for example, or reloading the browser somewhere other than the start page - failed with a server error when Yuvomi was installed under a folder whose name begins with a dot. Assets of third-party modules were affected the same way.

Umbrel installs Yuvomi in a standard location that is not affected by this, so existing households will notice no difference in day-to-day use; the fix matters for manual Docker installations in unusual directories.

The update needs nothing from you and applies no database change.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.57.4
