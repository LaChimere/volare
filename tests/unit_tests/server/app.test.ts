// Migration bridge: intentionally keep the legacy unit lane executing the moved
// HTTP integration suite until the server/app contract/security split is
// complete and all parity-ledger entries are terminal. This temporarily doubles
// execution across legacy and target lanes, but prevents silent coverage loss.
import '../../integration/http/server-app.test';
