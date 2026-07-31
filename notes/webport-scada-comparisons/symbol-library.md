**The definitions live mainly in two places:**

### 1. Symbol Library → `lib.conf` (primary place for suffixes)

This is where the standard suffixes and the rules for matching them are formally defined.

- Location: Each symbol library has a configuration file called **`lib.conf`** (JSON) in its folder under `/assets/libs/`.
- Key sections inside `lib.conf`:
  - **`"Suffix"`** – The central dictionary that maps suffixes to their meaning, for example:
    - `"PV"` → Value (process value)
    - `"SP"` → Setpoint
    - `"CMD"` → Command / Manoeuvre
    - `"AL"`, `"FAULT"`, `"M"`, etc.
  - **Objects** – Each object type (Sensor, Fan, Valve, …) contains:
    - `"ObjectFilter"` – which tag name patterns (prefixes/types) the object matches (e.g. `"GT|GP|GF|RUM|..."` for sensors)
    - `"States"` and `"Functions"` – the criteria and actions that use the suffixes (`V=0|CMD=0`, `_PV`, `_SP`, etc.)

The official documentation explicitly says that **suffixes are defined by the symbol libraries**.

### 2. Tag naming convention (product documentation + project standard)

There is a dedicated article in the WebPort support site:  
**“Tag naming convention”**

It states that the naming standard is based on **prefix + suffix**:
- The **prefix** connects the tags to an object on a page.
- The **suffix** defines the function of the tag and comes from the symbol library.

Examples given in the documentation:
- `AHU01_GT11_PV` → prefix = `AHU01_GT11`, suffix = `_PV`
- `VS01_GT11_CSP` → calculated setpoint

### About prefixes like `AS` and `VS`

These are **not** hard-coded product definitions.  
They come from the **project’s (or customer’s) naming convention**.

Typical structure in Swedish building-automation projects using WebPort:

```
Building_System_Component_Suffix
```

Examples:
- `AS` ≈ Apparatskåp / system identifier
- `VS` ≈ Ventilation system (or similar)
- `B01_AS001_VS01_GT101_PV`

The product only cares that the prefix is consistent so it can bind the object; the semantic meaning of “AS” or “VS” is defined in the project documentation / symbol library filters.

### Summary

| Element              | Where it is defined                          |
|----------------------|----------------------------------------------|
| Suffixes (`_PV`, `_SP`, `_CMD`, …) | Symbol library → `lib.conf` (`"Suffix"` section + Functions/States) |
| Object matching rules | Symbol library → `lib.conf` (`ObjectFilter`) |
| Prefixes (`AS`, `VS`, `AHU01`, …) | Project / customer naming standard          |
| Overall convention   | Documented in “Tag naming convention” + the active symbol library |

So if you want to see or change the official list of `_SP`, `_CMD`, `_PV` etc., look in the **`lib.conf`** of the symbol library that is being used on the pages.