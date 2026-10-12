/**
 * The app's single confirmation dialog, mounted once at the root.
 *
 * It lives here rather than on each screen because a navigation stack keeps the
 * screens beneath the current one mounted: a copy on both Library and Book
 * would put two identical modals on screen at the same time.
 */

import { ConfirmSheet } from './ConfirmSheet';
import { useLibrary } from '@/store/library';

export function GlobalConfirm() {
  const confirm = useLibrary((s) => s.confirm);
  const books = useLibrary((s) => s.books);
  const returnBook = useLibrary((s) => s.returnBook);
  const dismissConfirm = useLibrary((s) => s.dismissConfirm);

  const book = confirm ? books.find((b) => b.id === confirm.bookId) : undefined;
  const imported = !!book?.importedFromPhone;

  return (
    <ConfirmSheet
      visible={confirm?.kind === 'return-missing'}
      stamp={imported ? 'NOT ON DRIVE YET' : 'NOT ON DRIVE'}
      title="This is the only copy left."
      body={
        imported
          ? `${confirm?.title ?? 'This book'} was added from this phone and has not been copied to the drive yet. Returning it deletes the only copy you have. Plug in the drive and copy it across first to keep it.`
          : `${confirm?.title ?? 'This book'} isn't on the drive any more — it was moved, renamed or deleted since the last scan. Returning it deletes the last copy you have.`
      }
      confirmLabel="Return it anyway"
      cancelLabel="Keep it on my phone"
      onConfirm={() =>
        confirm ? returnBook(confirm.bookId, { confirmed: true }) : dismissConfirm()
      }
      onCancel={dismissConfirm}
    />
  );
}
