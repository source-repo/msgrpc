**Yes, the designer gets some help**, but it is mainly based on **naming conventions and filtering tools**, not on semantic metadata (units, ranges, data types, or equipment hierarchy).

### How tag selection works in the WebPort page builder

1. **Prefix-based binding (most common method)**  
   When you place or edit an object (sensor, valve, indicator, etc.), you set a **Prefix**.  
   The object then automatically connects to tags that share that prefix + standard suffixes (for example `_PV`, `_SP`, `_CMD`, etc.).  
   You rarely select every individual tag one by one.

2. **Generate Objects from Tags tool** (strongest assistance)  
   This is the main helper for choosing relevant tags:
   - Choose a symbol library and a tag list (all tags or a specific list).
   - Apply **prefix filters** with wildcards, e.g.:
     - `AS01_VS01`
     - `*VS01`
     - `*VS|*KB`
   - The system matches tags against the library’s **ObjectFilter** (e.g. tags containing `TS` or `ROOM` are mapped to temperature-sensor symbols).
   - Suffixes such as `_PV` are automatically stripped so the system can recognise the object type.

3. **Structured / object-oriented tag naming**  
   WebPort is designed around a hierarchical naming standard (typically something like `Building_System_Component_Function`).  
   When projects follow this convention consistently, the prefix filters and ObjectFilter matching become quite effective at presenting only relevant tags.

4. **Other supporting features**
   - Template pages that inherit prefixes
   - Visibility conditions and expressions that reference specific tags
   - Symbol libraries with predefined states and filters

### What the designer does *not* get

Unlike a modern OPC UA client that can show:
- Engineering Units
- EURange / InstrumentRange
- VariableType / TypeDefinition
- Hierarchical equipment objects

…WebPort’s page builder does **not** filter or warn based on units, scaling ranges, or semantic type.  

The help is syntactic (name patterns + conventions) rather than semantic. A designer who ignores the naming structure or the available filters can still bind an unrelated tag (e.g. a weight value to a temperature object).

### Summary

| Type of help                        | Available in WebPort page builder? | Strength |
|-------------------------------------|------------------------------------|----------|
| Prefix + standard suffixes          | Yes                                | High     |
| Generate Objects + name filters     | Yes                                | High     |
| ObjectFilter in symbol libraries    | Yes                                | Medium–High |
| Structured naming convention        | Yes (encouraged)                   | Depends on project discipline |
| Unit / range / type awareness       | No                                 | —        |
| Hierarchical equipment browser      | No                                 | —        |

So the designer **does** receive practical help through naming conventions and the Generate Objects / prefix-filter tools, but the protection against “unrelated properties” is weaker than in a well-modelled OPC UA environment.