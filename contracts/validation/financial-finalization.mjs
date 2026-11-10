// Frozen v1.0 conformance entry point; development-only, no runtime activation.
import {readFile} from 'node:fs/promises';
import {createFinancialReference} from './financial-reference.mjs';
export const spec=JSON.parse(await readFile(new URL('../financial-finalization.openapi.json',import.meta.url),'utf8'));
export const {validate,assertFinancialRequest,assertFinancialResult,assertPublicFinancialResult}=createFinancialReference(spec);
