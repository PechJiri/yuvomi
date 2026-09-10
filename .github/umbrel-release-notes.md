<!-- version: 2.65.2 -->
This is a security release, and it changes nothing about how Yuvomi looks or works day to day. It concerns API tokens that are limited to single modules, such as a token handed to an AI assistant or an MCP client. A token allowed to use the global search could read matching notes, contacts and medications through it, and a token allowed to read the dashboard received the data of every tile, although neither had been given those modules. Both now leave out every module the token was not given. Browser sessions and tokens without module limits see no change.

One thing to check after updating: a token that was given only the search or the dashboard scope now returns empty results until you add the modules it should be able to read.

Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.65.2
