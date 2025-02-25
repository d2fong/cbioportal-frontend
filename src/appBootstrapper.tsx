import React from 'react';
import ReactDOM from 'react-dom';
import { configure } from 'mobx';
import { Provider } from 'mobx-react';
import { Router } from 'react-router-dom';
import { createBrowserHistory } from 'history';
import { syncHistoryWithStore } from 'mobx-react-router';
import ExtendedRoutingStore from './shared/lib/ExtendedRouterStore';
import {
    fetchServerConfig,
    getLoadConfig,
    initializeAPIClients,
    initializeAppStore,
    initializeLoadConfiguration,
    initializeServerConfiguration,
    setServerConfig,
} from './config/config';

import './shared/lib/ajaxQuiet';
import _ from 'lodash';
import $ from 'jquery';
import * as superagent from 'superagent';
import { buildCBioPortalPageUrl } from './shared/api/urls';
import browser from 'bowser';
import { setNetworkListener } from './shared/lib/ajaxQuiet';
import { initializeTracking } from 'shared/lib/tracking';
import superagentCache from 'superagent-cache';
import { getBrowserWindow } from 'cbioportal-frontend-commons';
import { AppStore } from './AppStore';
import { handleLongUrls } from 'shared/lib/handleLongUrls';
import 'shared/polyfill/canvasToBlob';
import { setCurrentURLHeader } from 'shared/lib/extraHeader';
import Container from 'appShell/App/Container';
import request from 'superagent';
import { IServerConfig } from 'config/IAppConfig';
import { initializeGenericAssayServerConfig } from 'shared/lib/GenericAssayUtils/GenericAssayConfig';

export interface ICBioWindow {
    globalStores: {
        routing: ExtendedRoutingStore;
        appStore: AppStore;
    };
    routingStore: ExtendedRoutingStore;
    $: JQueryStatic;
    jQuery: JQueryStatic;

    e2etest: boolean;
    FRONTEND_VERSION: string;
    FRONTEND_COMMIT: string;
    rawServerConfig: IServerConfig;

    postLoadForMskCIS: () => void;
    isMSKCIS: boolean;
}

const browserWindow: ICBioWindow = window as any;

superagentCache(superagent);

configure({
    enforceActions: 'never',
    //disableErrorBoundaries: true
});
/*enableLogging({
    action: true,
    reaction: true,
    transaction: true,
    compute: true
});*/

// this must occur before we initialize tracking
// it fixes the hash portion of url when cohort patient list is too long
handleLongUrls();

// YOU MUST RUN THESE initialize and then set the public path after
initializeLoadConfiguration();
// THIS TELLS WEBPACK BUNDLE LOADER WHERE TO LOAD SPLIT BUNDLES
//@ts-ignore
__webpack_public_path__ = getLoadConfig().frontendUrl;

if (!browserWindow.hasOwnProperty('$')) {
    browserWindow.$ = $;
}

if (!browserWindow.hasOwnProperty('jQuery')) {
    browserWindow.jQuery = $;
}

// write browser name, version to body tag
if (browser) {
    $(document).ready(() => {
        $('body').addClass(browser.name);
    });
}

// e2e test specific stuff
if (getBrowserWindow().navigator.webdriver) {
    $(document).ready(() => {
        $('body').addClass('e2etest');
        browserWindow.e2etest = true;
    });
}

// if we are running e2e OR we are testing performance improvements manually
if (getBrowserWindow().navigator.webdriver || localStorage.recordAjaxQuiet) {
    setNetworkListener();
}

if (localStorage.getItem('timeElementVisible')) {
    const interval = setInterval(() => {
        const elementIsVisible = $(
            localStorage.getItem('timeElementVisible')!
        ).is(':visible');
        if (elementIsVisible) {
            clearInterval(interval);
            console.log(
                `TimeElementVisible for selector "${localStorage.timeElementVisible}"`,
                performance.now()
            );
        }
    }, 1000);
}

// for cbioportal instances, add an extra custom HTTP header to
// aid debugging in Sentry
if (/cbioportal\.org/.test(getBrowserWindow().location.href)) {
    setCurrentURLHeader();
}

// expose version on window
//@ts-ignore
browserWindow.FRONTEND_VERSION = VERSION;
//@ts-ignore
browserWindow.FRONTEND_COMMIT = COMMIT;

// this is special function allowing MSKCC CIS to hide login UI in
// portal header
browserWindow.postLoadForMskCIS = function() {
    getLoadConfig().hide_login = true;
    browserWindow.isMSKCIS = true;
};

// this is the only supported way to disable tracking for the $3Dmol.js
(browserWindow as any).$3Dmol = { notrack: true };

// make sure lodash doesn't overwrite (or set) global underscore
_.noConflict();

const routingStore = new ExtendedRoutingStore();

const history = createBrowserHistory({
    basename: getLoadConfig().basePath || '',
});

const syncedHistory = syncHistoryWithStore(history, routingStore);

const stores = {
    // Key can be whatever you want
    routing: routingStore,
    appStore: new AppStore(),
};

browserWindow.globalStores = stores;

//@ts-ignore
const end = superagent.Request.prototype.end;

let redirecting = false;

//@ts-ignore
superagent.Request.prototype.end = function(callback) {
    return end.call(this, (error: any, response: any) => {
        if (redirecting) {
            return;
        }
        if (response && response.statusCode === 401) {
            var storageKey = `login-redirect`;

            localStorage.setItem(storageKey, window.location.href);

            // build URL with a reference to storage key so that /restore route can restore it after login
            //@ts-ignore because we're using buildCBioPortalPageUrl without a pathname, which is normally required
            const loginUrl = buildCBioPortalPageUrl({
                query: {
                    'spring-security-redirect': buildCBioPortalPageUrl({
                        pathname: 'restore',
                        query: { key: storageKey },
                    }),
                },
            });

            redirecting = true;
            window.location.href = loginUrl;
        } else {
            callback(error, response);
        }
    });
};
//
browserWindow.routingStore = routingStore;

let render = (key?: number) => {
    if (!getBrowserWindow().navigator.webdriver) initializeTracking();

    const rootNode = document.getElementById('reactRoot');

    ReactDOM.render(
        <Provider {...stores}>
            <Router history={syncedHistory}>
                {/*@ts-ignore*/}
                <Container location={routingStore.location} />
            </Router>
        </Provider>,
        rootNode
    );
};

//@ts-ignore
if (__DEBUG__ && module.hot) {
    const renderApp = render;
    render = () => renderApp(Math.random());

    //@ts-ignore
    module.hot.accept('./routes', () => render());
}

$(document).ready(async () => {
    // we show blank page if the window.name is "blank"
    if (window.name === 'blank') {
        return;
    }

    // we use rawServerConfig (written by JSP) if it is present
    // or fetch from config service if not
    // need to use jsonp, so use jquery
    let initialServerConfig =
        browserWindow.rawServerConfig || (await fetchServerConfig());

    initializeServerConfiguration(initialServerConfig);

    //setConfigDefaults();

    initializeGenericAssayServerConfig();

    initializeAPIClients();

    initializeAppStore(stores.appStore);

    render();

    stores.appStore.setAppReady();
});
