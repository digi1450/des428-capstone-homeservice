// Area C — rating aggregates recomputed from `review.created` received through the broker. Catalog
// and Provider ratings stay with their owners in the monolith (they are NOT moved to Notifications).
// This consumer has its own dedupe name, so Notifications processing the same event does not
// suppress it. Recomputing from the reviews table is itself idempotent.
import * as catalogRepository from "../catalog/repository.js";
import * as providersRepository from "../providers/repository.js";
import { positiveId } from "../../messaging/inbound.js";

export const reviewCreatedHandler = {
  producer: "monolith",
  apply(envelope) {
    const serviceId = positiveId(envelope.data.service_id, "service id");
    const providerId = positiveId(envelope.data.provider_id, "provider id");
    catalogRepository.recomputeRatingAggregate(serviceId);
    providersRepository.recomputeRatingAggregate(providerId);
    return "recomputed";
  },
};
