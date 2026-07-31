**WebPort (Kiona Web Port)** is a web-based SCADA / building automation system commonly used in facility management (especially in the Nordic countries). It uses a classic tag-based model.

### Main attributes of a WebPort tag

When you configure a tag, these are the key attributes:

| Attribute             | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| **Name**              | Symbolic tag name (prefix + suffix)                          |
| **IO-device**         | The communication device / driver the tag is connected to    |
| **Address**           | Technical address in the underlying system (protocol-specific) |
| **Data type**         | Data type read from the device (e.g. INT, FLOAT)             |
| **Raw-min / Raw-max** | Raw value range coming from the device (used for scaling)    |
| **Eng-min / Eng-max** | Engineering (displayed) value range in WebPort (used for scaling **and** limiting operator input) |
| **Unit** (Enhet)      | Engineering unit shown with the value (e.g. `°C`, `Pa`, `%`, `kg`) |
| **Format**            | Display format (number of decimals, etc.) using .NET format strings (`0.0`, `0.00`, …). Required for scaling to work correctly |
| **Description**       | Human-readable text used in dialogs, alarm texts, and the user interface |
| **Alarm settings**    | Alarm criteria, priority, delay, area, acknowledge behaviour, etc. |
| **Trend settings**    | Logging interval, periodic vs change-of-value, etc.          |
| **Status / Value**    | Runtime communication status and current value               |

### Scaling in WebPort

WebPort performs **linear scaling** on the client/SCADA side using the four range values:

\[
\text{Eng value} = \text{Eng-min} + \left( \frac{\text{Raw value} - \text{Raw-min}}{\text{Raw-max} - \text{Raw-min}} \right) \times (\text{Eng-max} - \text{Eng-min})
\]

**Examples from the official documentation:**
- Raw 0–1000 → Eng 0–100 → effectively divides by 10
- Raw 4–20 → Eng 0–100 → classic 4–20 mA scaling

`Eng-min` / `Eng-max` are also used to limit the values an operator can enter in set-point fields.

### Relation to the earlier OPC UA discussion

Unlike a well-modelled OPC UA server (which exposes `EngineeringUnits`, `EURange` and `InstrumentRange` as metadata), **WebPort does not automatically inherit these attributes** from an OPC UA source in a standardised way.

The SCADA designer must manually configure:
- the **Unit**
- the **Raw ↔ Eng scaling** ranges
- the **Format**
- the **Description**

on each tag. This is the traditional SCADA approach — the metadata that helps avoid unit/scaling mistakes is present, but it has to be entered and maintained by the designer rather than being pulled automatically from a rich information model.

Would you like more detail on any specific attribute (alarms, trends, address extensions, etc.)?
