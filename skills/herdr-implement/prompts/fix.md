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
