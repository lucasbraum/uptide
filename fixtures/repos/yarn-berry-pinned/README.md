# yarn-berry-pinned

A synthetic repository whose `package.json` pins `yarn@4.7.0` through `packageManager`, with a
Yarn Berry lockfile and the node-modules linker. It is test data for the installer: on a
machine whose global `yarn` is classic 1.x (or none), `fix` runs the pinned version through
corepack. Nothing here is installed by the tests.
