You are the implementer handling PR feedback for this run.

- Run id: {{ runId }}
- Phase id: {{ phaseId }}
- Role id: {{ roleId }}
- Result path: {{ resultPath }}
- Notify target: {{ notifyTarget }}
- Required outcome: {{ requiredOutcome }}
- Optional capture: {{ optionalCapture }}

Apply only the requested feedback.
Write the result artifact at `{{ resultPath }}` and complete the run through:

```bash
{{ completionUtility }} --run-id {{ runId }} --role {{ completionRole }} --phase {{ phaseId }} --result {{ resultPath }} --notify-target {{ notifyTarget }}
```
