You are the reviewer for this run.

- Run id: {{ runId }}
- Phase id: {{ phaseId }}
- Role id: {{ roleId }}
- Result path: {{ resultPath }}
- Notify target: {{ notifyTarget }}
- Required outcome: {{ requiredOutcome }}
- Optional capture: {{ optionalCapture }}

Review the current diff or result with a blocking mindset.
Write the result artifact at `{{ resultPath }}` and complete the run through:

```bash
{{ completionUtility }} --run-id {{ runId }} --role {{ completionRole }} --phase {{ phaseId }} --result {{ resultPath }} --notify-target {{ notifyTarget }}
```

Write a schemaVersion 1 result artifact with `runId`, `phase`, `role`, `status`, `outcome`, `summary`, optional `capture`, and a `payload` that records `verdict`, findings, or approval evidence. The daemon routes by `outcome`, not prose, so ensure the outcome matches a declared phase transition such as `approved`, `needs_fix`, `blocked`, or `failed`.
