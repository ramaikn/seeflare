export function instrumentHistoryBuiltIns(callback: () => void) {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    // NOTE: Intentionally only declaring 2 parameters for these wrappers,
    //       because that is the arity of the built-in functions we're overwriting.

    // See: https://blog.sentry.io/wrap-javascript-functions/#preserve-arity

    // eslint-disable-next-line
    history.pushState = function (data, title /*, url */) {
        // eslint-disable-next-line
        origPushState.apply(this, arguments as any);
        callback();
    };

    // eslint-disable-next-line
    history.replaceState = function (data, title /*, url */) {
        // eslint-disable-next-line
        origReplaceState.apply(this, arguments as any);
        callback();
    };

    const listener = () => {
        callback();
    };
    addEventListener("popstate", listener);

    return () => {
        history.pushState = origPushState;
        history.replaceState = origReplaceState;
        removeEventListener("popstate", listener);
    };
}
