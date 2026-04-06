// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not reach into source-only paths that are not emitted in production builds.
export { mattermostPlugin } from "./src/channel.js";
