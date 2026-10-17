import type {
    ImportQueueItemsInput,
} from "./queue-item-schema.js";


export type HistoricalQueueItem =
  ImportQueueItemsInput["items"][number];


export function validateHistoricalQueueItem(
  item:
    HistoricalQueueItem,
): string | null {
  const createdAt =
    new Date(
      item.createdAt,
    );


  const startedAt =
    item.startedAt
      ? new Date(
          item.startedAt,
        )
      : null;


  const completedAt =
    item.completedAt
      ? new Date(
          item.completedAt,
        )
      : null;


  /**
   * A task cannot start before it was created.
   */
  if (
    startedAt &&
    startedAt.getTime() <
      createdAt.getTime()
  ) {
    return (
      "startedAt cannot be before createdAt."
    );
  }


  /**
   * ACTIVE tasks have not started or completed.
   *
   * Snoozed tasks are still ACTIVE and may have
   * deferUntil.
   */
  if (
    item.status ===
    "ACTIVE"
  ) {
    if (
      startedAt ||
      completedAt
    ) {
      return (
        "ACTIVE items cannot contain startedAt or completedAt."
      );
    }

    return null;
  }


  /**
   * IN_PROGRESS means work genuinely started.
   */
  if (
    item.status ===
    "IN_PROGRESS"
  ) {
    if (!startedAt) {
      return (
        "IN_PROGRESS items require startedAt."
      );
    }


    if (completedAt) {
      return (
        "IN_PROGRESS items cannot contain completedAt."
      );
    }

    return null;
  }


  /**
   * COMPLETED history needs both timestamps.
   */
  if (
    item.status ===
    "COMPLETED"
  ) {
    if (!startedAt) {
      return (
        "COMPLETED items require startedAt."
      );
    }


    if (!completedAt) {
      return (
        "COMPLETED items require completedAt."
      );
    }


    if (
      completedAt.getTime() <
      startedAt.getTime()
    ) {
      return (
        "completedAt cannot be before startedAt."
      );
    }

    return null;
  }


  /**
   * CANCELLED may have started before being
   * cancelled, so startedAt is optional.
   *
   * But cancellation is not completion.
   */
  if (
    item.status ===
    "CANCELLED"
  ) {
    if (completedAt) {
      return (
        "CANCELLED items cannot contain completedAt."
      );
    }

    return null;
  }


  return (
    "Unsupported QueueItem status."
  );
}