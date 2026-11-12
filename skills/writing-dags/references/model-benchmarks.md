# Model benchmarks for DAG assignments

Snapshot: **2026-11-11**. Selected coverage: **25 models, 45 measured configurations, 12 vendors**. Consult when comparing models or proposing profile changes; reuse supplied profiles for ordinary authoring. It is a dated comparison of measured configurations, not an exhaustive catalog, availability guarantee or certification of this DAG harness. `small` and `large` are workflow operating tiers, not parameter counts or measured capabilities.

## Comparable benchmark table

The scores below are **Artificial Analysis's own evaluations**, not mixed vendor launch claims. All four score columns are percentages, with different scoring semantics; compare models within a column, not across columns. Effort/mode belongs to the row identity. **Unknown effort is not the vendor default** and must not be relabeled `high` or `max`. Rows sharing a model name are separate measured operating points: read them as a ladder, not as one model's score.

| Row / model                  | AA measured effort or mode           | FrontierCode 2.0 | Terminal-Bench 4.0 | AutomationBench-AA | GDP.pdf | AA USD/task | AA min/task | Score source |
| ---------------------------- | ------------------------------------ | ---------------: | -----------------: | -----------------: | ------: | ----------: | ----------: | ------------ |
| R1 GPT-6.1 Sol               | Low                                  |             20.2 |               30.8 |               52.6 |    27.0 |        0.16 |         1.7 | [A1]         |
| R2 GPT-6.1 Sol               | Medium                               |             33.4 |               48.0 |               62.6 |    30.0 |        0.36 |         3.9 | [A1]         |
| R3 GPT-6.1 Sol               | High                                 |             36.7 |               51.5 |               64.5 |    32.0 |        0.59 |         6.7 | [A1]         |
| R4 GPT-6.1 Sol               | Xhigh                                |             38.5 |               54.0 |               66.6 |    31.8 |        0.76 |         9.0 | [A1]         |
| R5 GPT-6.1 Sol               | Max                                  |             40.6 |               56.1 |               64.9 |    31.0 |        1.27 |        20.2 | [A1]         |
| R6 GPT-6 Astra               | High                                 |             40.1 |               54.0 |               66.6 |    31.0 |        3.24 |         9.7 | [A2]         |
| R7 GPT-6 Astra               | Max                                  |             42.4 |               59.1 |               68.5 |    31.0 |        6.24 |        22.9 | [A2]         |
| R8 GPT-6.1 Terra             | Low                                  |             24.5 |               15.2 |               56.2 |    25.6 |        0.07 |         1.1 | [A3]         |
| R9 GPT-6.1 Terra             | High                                 |             37.5 |               41.9 |               58.5 |    28.0 |        0.26 |         4.0 | [A3]         |
| R10 GPT-6.1 Terra            | Max                                  |             42.3 |               55.6 |               60.2 |    28.6 |        0.96 |        13.5 | [A3]         |
| R11 GPT-6 Luna               | Low                                  |              2.2 |                0.0 |               12.0 |     9.0 |        0.01 |         0.6 | [A4]         |
| R12 Claude Fable 5.2         | High, Default Fallback               |             49.1 |               59.6 |               71.4 |    21.8 |        9.08 |        17.3 | [A5]         |
| R13 Claude Fable 5.2         | Xhigh, Default Fallback              |             47.6 |               61.6 |               74.2 |    21.4 |       14.83 |        26.1 | [A5]         |
| R14 Claude Fable 5.2         | Max, Default Fallback                |             48.8 |               59.6 |               76.4 |    24.2 |       26.54 |        45.2 | [A5]         |
| R15 Claude Opus 5.5          | Medium, Default Fallback             |             33.1 |               52.5 |               61.2 |    25.6 |        2.45 |         7.1 | [A6]         |
| R16 Claude Opus 5.5          | High, Default Fallback               |             35.9 |               56.6 |               63.2 |    28.8 |        3.46 |         9.5 | [A6]         |
| R17 Claude Opus 5.5          | Max, Default Fallback                |             46.4 |               59.6 |               69.5 |    26.2 |       10.04 |        25.0 | [A6]         |
| R18 Claude Sonnet 5.5        | Low, Default Fallback                |              7.1 |               20.7 |               49.4 |    16.0 |        0.51 |         2.5 | [A7]         |
| R19 Claude Sonnet 5.5        | High, Default Fallback               |             25.7 |               43.9 |               59.4 |    25.2 |        1.64 |         6.9 | [A7]         |
| R20 Claude Sonnet 5.5        | Max, Default Fallback                |             41.7 |               63.6 |               71.8 |    25.8 |       10.02 |        32.7 | [A7]         |
| R21 Claude Haiku 5.5         | Low                                  |              8.0 |               12.6 |               22.9 |    11.2 |        0.04 |         2.1 | [A8]         |
| R22 Claude Haiku 5.5         | High                                 |             23.2 |               21.7 |               33.7 |    17.2 |        0.16 |         6.4 | [A8]         |
| R23 Gemini 4 Carbon          | Low                                  |             29.6 |               62.6 |               63.5 |    28.6 |        7.19 |        22.6 | [A9]         |
| R24 Gemini 4 Carbon          | Medium                               |             39.5 |               60.6 |               77.6 |    29.6 |        6.59 |        23.3 | [A9]         |
| R25 Gemini 4 Carbon          | High                                 |             40.6 |               65.2 |               77.8 |    28.4 |        7.76 |        25.6 | [A9]         |
| R26 Gemini 4 Argon           | High                                 |             25.7 |               57.1 |               77.5 |    21.8 |        9.95 |        29.0 | [A10]        |
| R27 Gemini 3.8 Flash         | High                                 |             18.7 |               19.7 |               59.9 |    21.0 |        7.77 |        14.4 | [A11]        |
| R28 Gemini 3.5 Flash-Lite    | effort unknown                       |              6.0 |                1.0 |               25.0 |    13.6 |        0.69 |         1.6 | [A12]        |
| R29 Grok 4.7                 | High                                 |             27.8 |               24.7 |               63.5 |    23.2 |        6.18 |        22.3 | [A13]        |
| R30 Grok 4.7                 | Xhigh                                |             28.7 |               25.8 |               65.6 |    20.0 |        7.77 |        27.4 | [A13]        |
| R31 Muse Wonder              | Max                                  |             27.9 |               52.0 |               68.1 |    30.6 |        6.95 |        13.2 | [A14]        |
| R32 Qwen3.8 Max (0902)       | reasoning; effort unknown            |             23.4 |               38.9 |               56.2 |    22.8 |       10.02 |        54.8 | [A15]        |
| R33 Qwen3.8 27B              | Low                                  |             12.4 |                2.5 |               30.1 |    10.4 |        1.91 |        26.7 | [A16]        |
| R34 Qwen3.8 27B              | Xhigh                                |             14.9 |                5.6 |               48.2 |    16.4 |        3.53 |        39.8 | [A16]        |
| R35 Mistral Large 4          | High                                 |             15.0 |               24.7 |               57.8 |    17.6 |        2.06 |        11.5 | [A17]        |
| R36 Mistral Small 4          | Reasoning                            |              0.0 |                0.0 |                1.0 |     0.0 |        0.04 |         1.6 | [A18]        |
| R37 DeepSeek V4.1 Flash 1017 | High                                 |             16.8 |               28.8 |               68.5 |    14.2 |        0.46 |        12.9 | [A19]        |
| R38 DeepSeek V4.1 Flash 1017 | Max                                  |             28.5 |               33.8 |               66.6 |    17.2 |        0.60 |        16.5 | [A19]        |
| R39 Kimi K3.1 Pro            | reasoning; effort unknown            |             25.5 |               67.2 |               73.3 |    31.4 |        3.68 |        37.2 | [A20]        |
| R40 GLM-5.3                  | Low                                  |             12.7 |               34.8 |               52.0 |     8.8 |        1.57 |        14.4 | [A21]        |
| R41 GLM-5.3                  | Max                                  |             21.6 |               41.9 |               62.2 |    11.2 |        5.01 |        28.6 | [A21]        |
| R42 GLM-5.3-Flash            | reasoning; effort unknown            |             17.6 |               32.8 |               60.4 |    15.4 |        0.58 |        45.8 | [A22]        |
| R43 MiniMax-M3.1-Flash       | reasoning; effort unknown            |             20.8 |               25.8 |               72.5 |    20.8 |        0.49 |        14.4 | [A23]        |
| R44 MiMo-V2.6-Flash          | reasoning; numeric tier undocumented |             21.6 |               22.7 |               64.1 |     9.0 |        0.13 |        64.5 | [A24]        |
| R45 MiMo-V2.6-Pro            | reasoning; effort unknown            |             24.0 |               34.8 |               58.6 |    19.2 |        0.26 |        35.9 | [A25]        |

Zero is a published measured score, not a missing value. An unavailable measurement must be recorded as **unknown**, never zero. A low price or short task time alone is not positive task-fit evidence: R36's coding, terminal and document scores do not support recommending it for those responsibilities.

### Effort rows are different operating points

Raising effort changes the measured operating point; it is not a free quality dial, and the effect differs by model and by column:

- Claude Sonnet 5.5 climbs 7.1 → 25.7 → 41.7 on FrontierCode from low to high to max, while GDP.pdf moves 16.0 → 25.2 → 25.8 and cost rises $0.51 → $1.64 → $10.02.
- GPT-6.1 Sol rises 20.2 → 40.6 on FrontierCode across low → max, but USD/task rises $0.16 → $1.27 and inference time 1.7 → 20.2 minutes.
- Claude Fable 5.2's max row costs $26.54/task, 2.9× its high row, yet scores 48.8 against 49.1 on FrontierCode: the extra effort bought no coding score there.
- Gemini 4 Carbon's low row already scores 29.6 FrontierCode and 62.6 Terminal-Bench at $7.19; stepping to high buys 11.0 FrontierCode points for +$0.57 but only 2.6 Terminal-Bench points.

A vendor default is not necessarily the measured row, and an effort suffix does not guarantee monotonic improvement. Treat the cheapest row that clears the node's measured demands as the candidate, then verify the gain on representative tasks; effort claims do not transfer between columns, models or providers.

## What these measurements mean

[AA methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking), Intelligence Index **v5.0.1**:

- **FrontierCode 2.0:** real-repository software changes, 132 tasks and three repeats in AA's Stirrup harness. Mean verifier/rubric score, with zero for a blocking-check failure; not simply the percentage of issues solved.
- **Terminal-Bench 4.0:** terminal tasks, 66 tasks and three repeats using mini-swe-agent. Mean pass@1, requiring all task tests to pass.
- **AutomationBench-AA:** 657 held-out SaaS workflow tasks with structured REST tools, one run. Mean objective completion, zeroed on a guardrail violation; not an all-or-nothing task pass rate or proof of repository-editing skill.
- **GDP.pdf:** professional document reasoning, 100 tasks and five repeats. Rubric all-pass; not a maximum-context repository-understanding test.
- **AA USD/task:** weighted average cost per Intelligence Index task, including unsuccessful attempts. Not cost per accepted result, a provider quote, or the user's subscription expense.
- **AA min/task:** estimated inference time per Index task from token use and endpoint speed. Not complete wall-clock time including tools, scheduling or judging, and not a measurement of the user's endpoint.

The overall Intelligence Index is deliberately omitted: its category weighting is not the weighting of every DAG node. No confidence intervals were established from these comparison pages; narrow differences are not proof of statistically superior reliability. Benchmark versions, harnesses, checkpoints and efforts must match before treating numbers as comparable. Model updates or different operating points require fresh evidence; retain this snapshot's date rather than silently treating it as current forever.

## Native identities and operating points

These are **native API IDs**, not complete Pi `provider/model[:thinking]` selectors. AA page slugs are not native IDs for several models (`glm-5.3` vs `glm-5-3`, `qwen3.8-27b` vs `qwen3-8-27b`, `grok-4.7` vs `grok-4-7`); use the exact ID exposed by the chosen authenticated provider, because gateways can use different aliases. Vendor documentation below establishes identity, reasoning and tool support, not account access or benchmark parity. The current DAG suffix grammar and SDK clamping rules still apply; a vendor-native setting is not automatically expressible by this SDK.

| Models (rows) | Native identity / checkpoint                                                          | Documented native reasoning controls                                                                                            | Vendor evidence                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1–R5         | `gpt-6.1-sol`                                                                         | `reasoning.effort` low, medium, high, xhigh, max; documented default medium; measured at all five                               | [Model/ID, effort and tools](https://developers.openai.com/api/docs/models/gpt-6.1-sol)                                                                                         |
| R6–R7         | `gpt-6-astra`                                                                         | `reasoning.effort` low, medium, high, xhigh, max; `none` rejected; default not documented; measured high and max                | [Model/ID](https://developers.openai.com/api/docs/models/gpt-6-astra), [reasoning](https://developers.openai.com/api/docs/guides/reasoning)                                     |
| R8–R10        | `gpt-6.1-terra`                                                                       | `reasoning.effort` low, medium, high, xhigh, max; default not documented; measured low, high, max                               | [Model/ID, effort and tools](https://developers.openai.com/api/docs/models/gpt-6.1-terra)                                                                                       |
| R11           | `gpt-6-luna`                                                                          | `reasoning.effort` low, medium, high, xhigh, max; documented default medium; measured low                                       | [Model/ID, effort and tools](https://developers.openai.com/api/docs/models/gpt-6-luna)                                                                                          |
| R12–R14       | `claude-fable-5-2`                                                                    | `output_config.effort` low through max; measured high, xhigh, max; AA includes Default Fallback                                 | [Model/ID](https://platform.claude.com/docs/en/models/fable-5-2/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort)                               |
| R15–R17       | `claude-opus-5-5`                                                                     | `output_config.effort` low, medium, high, xhigh, max; default medium; adaptive thinking always on; measured medium, high, max   | [Model/ID](https://platform.claude.com/docs/en/models/opus-5-5/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort)                                |
| R18–R20       | `claude-sonnet-5-5`                                                                   | `output_config.effort` low through max; default not documented; measured low, high, max                                         | [Model/ID](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort)                              |
| R21–R22       | `claude-haiku-5-5`                                                                    | `output_config.effort` low through max; default not documented; measured low, high                                              | [Model/ID](https://platform.claude.com/docs/en/models/haiku-5-5/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort)                               |
| R23–R25       | `gemini-4-carbon`                                                                     | `thinking_level` low, medium, high; default medium; measured all three                                                          | [Model/ID](https://aistudio.google.com/docs/models/gemini-4-carbon.md), [thinking](https://aistudio.google.com/docs/thinking.md)                                                |
| R26           | `gemini-4-argon`                                                                      | `thinking_level` low, medium, high; measured high, not vendor default medium                                                    | [Model/ID](https://aistudio.google.com/docs/models/gemini-4-argon), [thinking](https://aistudio.google.com/docs/whats-new-gemini-4-argon#understanding-thinking-levels)         |
| R27           | `gemini-3.8-flash`                                                                    | `thinking_level` low, medium, high; default medium; `minimal` rejected; measured high                                           | [Model/ID](https://aistudio.google.com/docs/models/gemini-3.8-flash.md), [thinking](https://aistudio.google.com/docs/thinking.md)                                               |
| R28           | `gemini-3.5-flash-lite`                                                               | minimal, low, medium, high; AA effort unknown, not assumed minimal                                                              | [Model/ID](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), [thinking](https://aistudio.google.com/docs/thinking#thinking-levels)                                |
| R29–R30       | `grok-4.7`                                                                            | `reasoning_effort` low, medium (default), high, xhigh; reasoning cannot be disabled; measured high, xhigh                       | [Model/ID](https://docs.x.ai/developers/grok-4-7.md), [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning.md)                                            |
| R31           | `muse-wonder-1.0`                                                                     | `reasoning.effort` minimal, low, medium, high, xhigh, max; default max; `none` rejected; measured max                           | [Model/ID](https://dev.meta.ai/docs/muse-wonder), [reasoning](https://dev.meta.ai/docs/reasoning)                                                                               |
| R32           | `qwen3.8-max-0902`, also documented as `qwen3.8-max-2026-09-02`; `qwen3.8-max` floats | Thinking toggle; low, medium, xhigh; high/max map to xhigh. AA effort remains unknown                                           | [Model/snapshots](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max), [API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |
| R33–R34       | `qwen3.8-27b`                                                                         | `enable_thinking` true/false, default enabled, plus `thinking_budget`; no effort tiers documented; AA measured low and xhigh    | [Model/ID](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-27b), [thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)                          |
| R35           | `mistral-large-4`, also `mistral-large-4-0`                                           | `reasoning_effort` low, medium, high (documented recommended default); `none` rejected; measured high                           | [Model/ID](https://docs.mistral.ai/models/mistral-large-4-0), [reasoning](https://docs.mistral.ai/inference/conversations/reasoning)                                            |
| R36           | `mistral-small-2603`                                                                  | high enables reasoning; none is minimal/no-trace. AA's exact request remains undisclosed                                        | [Model/ID](https://docs.mistral.ai/models/mistral-small-4-0-26-03), [reasoning API](https://docs.mistral.ai/inference/conversations/reasoning)                                  |
| R37–R38       | `deepseek-flash` currently maps to `DeepSeek-V4.1-Flash-1017`                         | Thinking enabled; actual effort tiers low, high, max; measured high, max                                                        | [Identity](https://api-docs.deepseek.com/quick_start/pricing), [reasoning/tools](https://api-docs.deepseek.com/guides/thinking_mode)                                            |
| R39           | `kimi-k3.1-pro`                                                                       | Always thinking; low, high, max. AA effort remains unknown                                                                      | [Native API, effort and tools](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)                                                                                    |
| R40–R41       | `glm-5.3`                                                                             | Thinking enabled only; `reasoning_effort` low, high, max; documented default max; measured low, max                             | [Model](https://docs.z.ai/guides/llm/glm-5.3), [API](https://docs.z.ai/api-reference/llm/chat-completion)                                                                       |
| R42           | `glm-5.3-flash`                                                                       | Thinking enabled only; low, high, max. AA effort remains unknown                                                                | [Model](https://docs.z.ai/guides/vlm/glm-5.3-flash), [API](https://docs.z.ai/api-reference/llm/chat-completion)                                                                 |
| R43           | `MiniMax-M3.1-Flash` (case-sensitive spelling preserved)                              | Always thinking; low, medium, high, xhigh, max. AA effort remains unknown                                                       | [OpenAI interface](https://platform.minimax.io/docs/api-reference/text-openai-api), [Anthropic interface](https://platform.minimax.io/docs/api-reference/text-anthropic-api)    |
| R44           | `mimo-v2.6-flash`; AA links `XiaomiMiMo/MiMo-V2.6-Flash-RL`                           | Thinking enabled/disabled; no numeric tier established                                                                          | [Release/ID](https://mimo.mi.com/docs/en-US/news/latest/v2-6), [reasoning/tools](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)          |
| R45           | `mimo-v2.6-pro`                                                                       | Thinking enabled/disabled; no numeric tier documented; release notes say the weights were open-sourced without naming a license | [Release/ID](https://mimo.mi.com/docs/en-US/news/latest/v2-6), [reasoning/tools](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)          |

OpenAI tool calling at the selected operating points requires the Responses API, and Luna's Chat Completions function calling is restricted to effort none. Anthropic's dateless IDs are [pinned snapshots](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions). The Fable, Opus and Sonnet rows explicitly measure **Default Fallback**: the [documented endpoint behavior](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback) can retry a classifier-refused request on another Claude model. Those rows are not isolated-model/no-fallback capability measurements, and this SDK's behavior is not established by them; no fallback mechanism is proposed here.

Check licensing with the vendor before redistribution: AA reports GLM-5.3-Flash, MiniMax-M3.1-Flash and MiMo-V2.6-Flash as proprietary, Mistral Large 4 documents open weights under the Mistral Ecosystem Open Weight License v26.10, MiMo-V2.6-Pro release notes describe open-sourced weights without naming a license, and Muse Wonder is an API-hosted preview.

For rows with undisclosed effort, proposing a documented explicit effort is a **different, unverified operating point**. State that gap instead of attributing the row's scores to the proposed suffix. Likewise, a supported context window, image input or structured-output mode must be checked in the selected provider's documentation; the benchmark scores do not prove those support guarantees. The configured `opencode-go/deepseek-v4.1-flash:high` uses a gateway ID, not DeepSeek's native alias; [OpenCode's rollout announcement](https://x.com/opencode/status/2112220734768779441) says Go/Free updated that model to 1017 without configuration changes.

## Match the node, then recommend a profile

| Node requirement                                                                | Relevant evidence                                                                      | Selection guidance                                                                                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic execution or validation                                           | Executable inputs and checks                                                           | Use a command node; no model is needed.                                                                                                                                  |
| Bounded extraction, known-path lookup or a specified local edit                 | Relevant accepted examples and objective checks; no direct certification in this table | Consider economical candidates rather than defaulting to large. Keep task ambiguity and evidence requirements explicit; benchmark cost alone does not establish success. |
| Ambiguous debugging, interacting repository changes or implementation synthesis | FrontierCode; Terminal-Bench only where terminal demands actually apply                | Compare relevant capability with cost/time and name the concrete gap that justifies a stronger candidate. Do not use file count or the word “coding” as a size rule.     |
| Structured SaaS/API workflow                                                    | AutomationBench-AA, matched tool interfaces and guardrails                             | Tool workflow skill is its own dimension; do not infer that the coding leader is universally best.                                                                       |
| Difficult multi-document synthesis                                              | GDP.pdf plus actual input length/modality requirements                                 | Compare document-reasoning evidence and verify provider limits separately; capacity is not retrieval/reasoning accuracy.                                                 |
| Same model at a different reasoning effort                                      | That model's other rows, compared within the column the node depends on                | Prefer the cheapest effort that clears the node's demands; gains are often small relative to cost and can reverse (R12–R14). Re-check against the real workload.         |
| Independent acceptance review                                                   | Existing large-profile requirement plus review-specific evidence                       | Keep a large profile. None of these benchmarks certifies security-review judgment or semantic acceptance quality.                                                        |

Prefer the lower-cost/time candidate when relevant evidence supports the node's required quality; retain a stronger candidate when a concrete capability, uncertainty or review-policy requirement warrants it. Missing evidence remains unknown, not proof that the largest model solves the problem. Compare representative tasks in the real DAG harness before claiming local reliability or savings; such model calls need separate authorization. Workers have bounded read/write/edit and submission tools, not shell/delegation, so terminal-agent scores are indirect evidence.

For a consequential recommendation, state the **node/group and required capability → current profile/mapping if known → candidate row, native model ID, exact measured effort/mode and intended small/large tier → relevant metric/source/date → tradeoff and activation prerequisites**. Equivalent nodes may share one decision. Separate a defect from an optional candidate; a better public score is not proof that the current assignment fails.

The author can inspect the supplied profiles configuration. Bundled `review-dag` receives the target YAML and a frozen copy of this reference, not target profile mappings: it must keep unknown mappings unknown and make new-profile/model suggestions as conditional Markdown advice. Author approval, an available/authenticated provider, exact ID/effort/tool support and ordinary validation are prerequisites before activation. Suggestions do not create profiles, activate models or authorize provider probes. No automatic router or fallback is implied.

## Benchmark sources

Each entry is the AA model page cited by its rows; non-default effort rows come from sibling pages named `<slug>-<effort>` (`-low`, `-medium`, `-high`, `-xhigh`), read on the snapshot date. Methodology: [AA Intelligence Index v5.0.1](https://artificialanalysis.ai/methodology/intelligence-benchmarking).

[A1]: https://artificialanalysis.ai/models/gpt-6-1-sol
[A2]: https://artificialanalysis.ai/models/gpt-6-astra
[A3]: https://artificialanalysis.ai/models/gpt-6-1-terra
[A4]: https://artificialanalysis.ai/models/gpt-6-luna
[A5]: https://artificialanalysis.ai/models/claude-fable-5-2
[A6]: https://artificialanalysis.ai/models/claude-opus-5-5
[A7]: https://artificialanalysis.ai/models/claude-sonnet-5-5
[A8]: https://artificialanalysis.ai/models/claude-haiku-5-5
[A9]: https://artificialanalysis.ai/models/gemini-4-carbon
[A10]: https://artificialanalysis.ai/models/gemini-4-argon
[A11]: https://artificialanalysis.ai/models/gemini-3-8-flash
[A12]: https://artificialanalysis.ai/models/gemini-3-5-flash-lite
[A13]: https://artificialanalysis.ai/models/grok-4-7
[A14]: https://artificialanalysis.ai/models/muse-wonder
[A15]: https://artificialanalysis.ai/models/qwen3-8-max
[A16]: https://artificialanalysis.ai/models/qwen3-8-27b
[A17]: https://artificialanalysis.ai/models/mistral-large-4
[A18]: https://artificialanalysis.ai/models/mistral-small-4
[A19]: https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017
[A20]: https://artificialanalysis.ai/models/kimi-k3-1-pro
[A21]: https://artificialanalysis.ai/models/glm-5-3
[A22]: https://artificialanalysis.ai/models/glm-5-3-flash
[A23]: https://artificialanalysis.ai/models/minimax-m3-1-flash
[A24]: https://artificialanalysis.ai/models/mimo-v2-6-flash
[A25]: https://artificialanalysis.ai/models/mimo-v2-6-pro
