import { agentsChallenge } from "./agents-challenge";
import { agentsRegister } from "./agents-register";
import type { Op } from "./define";
import { health } from "./health";

/** Every operation the platform exposes. REST, MCP and OpenAPI are all built from this list. */
export const ops: Op[] = [health, agentsChallenge, agentsRegister];
