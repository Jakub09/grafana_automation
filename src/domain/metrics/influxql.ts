/** Identyfikator InfluxQL w cudzysłowach: "HF.STG_SPACE" */
export const quoteIdentifier = (name: string) => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Literał tekstowy InfluxQL: 'wartość' */
export const quoteString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
