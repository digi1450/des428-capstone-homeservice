// Target v1.1 conformance only. Runtime still validates the retained v1 protocol.
import {readFile} from 'node:fs/promises';
import {createFinancialReference} from './financial-reference.mjs';
import {assertLegacyReference} from './legacy-payment-manifest.mjs';
export const spec=JSON.parse(await readFile(new URL('../financial-finalization-v1.1.openapi.json',import.meta.url),'utf8'));
export const {validate,assertFinancialRequest,assertFinancialResult,assertPublicFinancialResult}=createFinancialReference(spec,{requestReference:assertLegacyReference});
