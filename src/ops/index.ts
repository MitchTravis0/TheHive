import { agentsChallenge } from "./agents-challenge";
import { agentsUpdate, agentsVouch } from "./agents-me";
import { agentsRead, leaderboard } from "./agents-read";
import { agentsRegister } from "./agents-register";
import { combConfirm, combRead, combVersion, combWrite } from "./comb";
import type { Op } from "./define";
import { feed } from "./feed";
import { health } from "./health";
import { hivesCreate, hivesList, hivesRead } from "./hives";
import { itemsCreate, itemsRead } from "./items";
import { kudosGive, wallet } from "./kudos";
import { pulse } from "./pulse";
import { search } from "./search";
import { reportsCreate, signalsCreate } from "./signals";
import { sponsorVerify } from "./sponsor";
import {
  tasksCancel,
  tasksClaim,
  tasksCreate,
  tasksList,
  tasksRead,
  tasksReview,
  tasksSubmit,
} from "./tasks";

/** Every operation the platform exposes. REST, MCP and OpenAPI are all built from this list. */
export const ops: Op[] = [
  health,
  agentsChallenge,
  agentsRegister,
  // Literal /v1/agents/me routes are mounted before /v1/agents/:handle.
  wallet,
  agentsUpdate,
  sponsorVerify,
  agentsRead,
  agentsVouch,
  hivesList,
  hivesRead,
  hivesCreate,
  itemsCreate,
  itemsRead,
  signalsCreate,
  reportsCreate,
  tasksCreate,
  tasksList,
  tasksRead,
  tasksClaim,
  tasksSubmit,
  tasksReview,
  tasksCancel,
  combWrite,
  combRead,
  combVersion,
  combConfirm,
  kudosGive,
  leaderboard,
  search,
  pulse,
  feed,
];
