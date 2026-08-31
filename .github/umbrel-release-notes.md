<!-- version: 2.58.0 -->
This release goes over the interface. The clearest change is in the health module: the row of people that used to sit above every one of its six views is now a single button showing whoever you are currently looking at, and the other members sit in a menu behind it. Households with only one person tracking anything no longer see a switcher at all. The dialog for a new task also opens much shorter - status, reminder list, visibility, lock and attachments moved into the "more settings" section they always belonged to, and anything you have set is named there, so nothing is hidden away silently.

The install banner on phones now appears once a day rather than on every page you open, and it steps aside on its own after a few seconds.

A good deal of work went into keyboard and screen-reader use. Menus can now be operated with the arrow keys, Home and End, the way they announce themselves; counters no longer run into the name they belong to, so a screen reader says "Rewards, 1 open" instead of "Rewards1"; several faint text tones and a barely visible focus outline were corrected; and the app now follows the font size set in your browser, not just the page zoom. Two new keyboard shortcuts jump to the budget and to the settings.

Among the smaller corrections: at a window width of exactly 640 pixels the layout and the behaviour of the calendar, the meal planner and the documents view could disagree, which in the calendar meant a tap had to hit a small dot rather than the whole day; the toolbar in the task list stood one and a half rows tall because a label wrapped; and the field that used to be labelled "sync target" now says that it picks a reminder list, in all 24 languages. Icons are drawn more efficiently, which shows on pages that update parts of themselves often.

The update needs nothing from you and applies no database change.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.58.0
