<!-- version: 2.64.0 -->
This release fixes something the budget plan got wrong about the past. Your plan is one steady amount per category, and nothing recorded what it said in earlier months - so lowering a budget today could turn a month that closed long ago red, for spending that was well inside the plan you actually had at the time. From now on Yuvomi only calls a month over or under budget while that month is still running. For every earlier month it still shows what was planned and what was spent, and says plainly that it is measuring against your current plan instead of declaring a winner.

The project also now publishes what it will not build. If you have ever wondered whether a direct bank connection or a particular third-party integration is coming, there is a short document that answers it, says which parts are still open, and explains the reasoning - so an idea gets the same answer no matter where you ask it.

Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.64.0
