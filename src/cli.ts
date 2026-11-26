#!/usr/bin/env node
import { createDefaultContext, runCli } from "./runner.js";

const exitCode = await runCli(createDefaultContext(process.argv.slice(2)));
process.exitCode = exitCode;
