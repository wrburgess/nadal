import { dispatch } from "./router.js";

const code = await dispatch(process.argv.slice(2));
// Set exitCode and let the event loop drain naturally instead of process.exit(),
// which can truncate stdout writes still in flight when output is piped.
process.exitCode = code;
