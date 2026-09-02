<!-- version: 2.63.0 -->
This release is mostly about what runs alongside Yuvomi. If you have installed a third-party module, it can now do what the built-in ones do: bring its own tiles to the dashboard, appear in the household permissions so you can decide who may use it, offer its API to tokens with a scope of its own, and speak your language through translation files it ships itself. Modules written before this update keep working unchanged; the new abilities are there for module authors to adopt, and a module that declares a manifest format Yuvomi cannot read is refused up front rather than loaded in part.

Every page in the app, including the page a module renders, now follows one written layout contract. The immediate effect is quiet: headers end where their content ends, and a module page looks like a Yuvomi page instead of a guest. The contract is public, so anyone building a module can read what a page is expected to do rather than guess from the built-in ones.

For contributors, the guidelines now say who cleans up a pull request that has gone stale while it waited: the maintainer takes the mechanical part, the author keeps the decisions inside the feature, and an open architecture question never holds a contribution back.

Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.63.0
