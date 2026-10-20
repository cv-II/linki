# Careervira Console bridge

Server-to-server routes that let the Careervira Console drive this Linki. Everything lives in `lib/bridge.ts` and
`pages/api/bridge/[...path].ts`. Linki's own code is changed in one place only: `lib/db.ts` calls `ensureBridgeSchema(db)`
once at startup (adds `targets.external_id` and two small tables, nothing is changed or removed).

## Set up
| Variable | Meaning |
|---|---|
| `INTERNAL_API_SECRET` | Shared secret. The Console sends it as `x-internal-secret`. Linki already checks it on every `/api/*` call. |
| `BRIDGE_WORKFLOW_ID` | The Linki workflow (sequence) Console campaigns run. Optional if you have exactly one workflow. |
| `BRIDGE_ACCOUNT_ID` | The LinkedIn account that sends. Defaults to the first signed-in account. |
| `BRIDGE_EMAIL_ACCOUNT_IDS` | Comma-separated email accounts, used round-robin if the workflow has email steps. |

In the Console set `LINKI_URL=http://<linki>:3000` and `LINKI_INTERNAL_SECRET` to the same secret. Apollo's key stays in Linki (Settings, Integrations).

## Routes (all under `/api/bridge`)
| Route | Does |
|---|---|
| `POST campaigns/:id/members` `{leads:[{id,name,title,company,email,linkedin_url,dnc}]}` | Creates the Linki list and run on first use, adds people, enrols them. Skips Do-not-contact, people already in this workflow and people active in another running campaign. Repeat is safe. |
| `POST campaigns/:id/start`, `pause`, `stop` | Runs the sequence, pauses it, or ends it (waiting leads are skipped; stop cannot be undone). |
| `DELETE leads/:id` | Skips the person's waiting steps everywhere. Unknown person is fine. |
| `POST enrich` `{id,name,company,linkedin_url}` | Apollo lookup. Errors carry `key_missing`, `key_rejected`, `rate_limited` or `apollo_down`. |
| `GET events?after=&limit=` | `{events:[{id,type,lead_id,at}], next}`. Types: invite_sent, invite_accepted, message_sent, linkedin_reply, email_sent, email_reply, email_bounced. |
| `POST invites/withdraw` | **Not built.** Answers 501. Needs a tested LinkedIn action. |

Events are derived from timestamps the runner already writes on `targets`, so the runner is untouched.

## Tests
`npx tsx --test tests/bridge.test.ts` (throwaway database).

## Not verified
Real LinkedIn sending, real email, real Apollo answers. Everything was exercised against a test database only.
