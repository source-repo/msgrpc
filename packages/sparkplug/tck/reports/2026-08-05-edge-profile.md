# Eclipse Sparkplug TCK 3.0.0 Edge profile baseline

Date: 2026-08-05

This is a reproducible development baseline for `@source-repo/sparkplug`. It is not an Eclipse Foundation compatibility claim or listing.

## Inputs

- Official binary: https://download.eclipse.org/sparkplug/3.0.0/Eclipse-Sparkplug-TCK-3.0.0.zip
- Binary SHA-256: `a70b2c2f00d67ac714eadd5ac50f6241e0efa26036d95ca8ec667d491021b86b`
- HiveMQ image: `hivemq/hivemq-ce@sha256:5f440cd2e286a3810001939767e3d91bd056a5687611344e929b5198090567d5`
- Runner: `npm run tck:edge -w @source-repo/sparkplug`
- Raw official result log: [2026-08-05-edge-profile.log](./2026-08-05-edge-profile.log)

## Results

| Scenario | Overall | PASS | FAIL | Not executed | MAYBE |
| --- | --- | ---: | ---: | ---: | ---: |
| SessionEstablishment | PASS but INCOMPLETE | 77 | 0 | 1 | 0 |
| SessionTermination | PASS but INCOMPLETE | 24 | 0 | 1 | 0 |
| SendData | PASS but INCOMPLETE | 34 | 0 | 10 | 0 |
| SendComplexData | PASS but INCOMPLETE | 32 | 0 | 24 | 1 |
| ReceiveCommand | PASS | 14 | 0 | 0 | 0 |
| PrimaryHost | PASS | 23 | 0 | 0 | 0 |

## Scope and exclusions

- The Edge profile scenarios run over MQTT 3.1.1: Session Establishment, Session Termination, Send Data, Send Complex Data, Receive Command, and Primary Host.
- The optional Multiple Broker scenario is not run because the package currently owns one MQTT connection.
- Dataset and Template payload groups are not exercised because those datatypes are outside the current M1 encoder.
- MQTT 5 alternatives and optional payload groups may therefore remain `NOT EXECUTED`; SHOULD-level observations may be reported as `MAYBE`.
- Before the fixes captured by this baseline, Session Establishment returned `OVERALL: FAIL but INCOMPLETE`: generated topics used `spBv1.0/<message-type>/<group>/...` instead of the required `spBv1.0/<group>/<message-type>/...`, so the TCK could not identify the Edge Node Will. The same slice added the mandatory false `Node Control/Rebirth` NBIRTH metric and DCMD subscription.
