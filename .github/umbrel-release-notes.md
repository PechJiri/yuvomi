<!-- version: 2.65.1 -->
A small update with one fix you should know about: the search box at the top of the app could show a household member the title and date of another member's private calendar appointment, and of events from a subscribed calendar that was never shared. The calendar itself never showed them; the search did. Search now applies the same visibility rules as the calendar, so the two return the same hits for the same word. This update runs no database migration and starts as quickly as any other; a backup before updating is still a good habit.

Leaving the dashboard now really leaves it. Its clock, its quiet refresh, the weather timer and the wall kitchen timer used to keep running in the background after you moved to another page, and could redraw or even chime there. They stop the moment you navigate away, and a dashboard refresh that was overtaken by another one no longer paints an older state over a newer one.

In the calendar, birthdays stay visible while you filter by person. They used to disappear with any selection, because a birthday belongs to a contact rather than to a household member. The "Birthdays" switch in the filter sheet remains the way to hide them.

If your Mealie or Tandoor runs on a private address such as 192.168.x.x, the app now tells you which setting to enable instead of blaming your credentials: RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK=true. That switch has been required for such addresses since 2.64.1 closed a gap in the network guard; the message has caught up with it. The mail library moved to nodemailer 10; password-reset and invitation mails work as before, and the SMTP settings are unchanged.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.65.1
