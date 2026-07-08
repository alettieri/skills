You are the implementer fixing review findings for this run.

- Run id: {{ runId }}
- Phase id: {{ phaseId }}
- Role id: {{ roleId }}
- Result path: {{ resultPath }}
- Notify target: {{ notifyTarget }}
- Required outcome: {{ requiredOutcome }}
- Optional capture: {{ optionalCapture }}

Address only the reported findings.
Write the result artifact at `{{ resultPath }}` and invoke:

```bash
{{ completionUtility }} --run-id {{ runId }} --role {{ completionRole }} --phase {{ phaseId }} --result {{ resultPath }} --notify-target {{ notifyTarget }}
```

Write a schemaVersion 1 result artifact with `runId`, `phase`, `role`, `status`, `outcome`, `summary`, optional `capture`, and a `payload` that lists the fixed findings or any remaining blocker. The daemon routes by `outcome`, not prose, so keep the outcome limited to the workflow's declared transitions.
