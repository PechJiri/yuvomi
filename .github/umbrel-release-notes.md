<!-- version: 2.64.1 -->
This is a security release, and it changes nothing about how Yuvomi looks or works day to day. Four reports from security researchers are fixed: a family member could edit or delete another member's private calendar event; the Webhook, Gotify and ntfy notification channels could be pointed at addresses inside your own network; a redirect could steer a calendar feed fetch to an internal address; and a shared expense could be attributed to someone outside its group, while a paid housekeeping visit could be changed by anyone.

One thing to check after updating: if your Gotify or ntfy server, or a webhook target such as Home Assistant, runs in the same Docker network or on your LAN, notification delivery to it now stops until you set NOTIFICATION_ALLOW_PRIVATE_NETWORK=true in the app's environment. The channel shows the reason in its status, and the setting is described in the installation guide.

Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.64.1
