<!-- version: 2.57.1 -->
This is a security update. It closes a flaw in how API tokens are confined. Yuvomi lets an administrator hand out API tokens that are limited to certain modules, so an external tool sees only what it needs. Until now a limited token could still reach the account-management routes and, from there, create an unrestricted token or a new administrator, escaping the very limit it was given.

If you have never created a limited API token, nothing changes for you. If you use API tokens for integrations or connected assistants, updating is recommended, and reviewing your existing tokens afterwards does no harm.

The update needs nothing from you and applies no database change; it takes effect as soon as Yuvomi restarts.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.57.1
