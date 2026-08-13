/* eslint-disable import/prefer-default-export */
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import SteamTotp from 'steam-totp';
import SteamUser from 'steam-user';
import promiseTimeout from 'p-timeout';
import { getStoreValue, setStoreValue } from './store.js';
import type { LoginCredential } from './config.js';
import logger from './logger.js';

export const loginSteamWeb = async (user: LoginCredential): Promise<string[]> => {
  const L = logger.child({ username: user.username });
  L.debug('Logging user into steam web session');
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  const refreshToken = await getStoreValue('refreshToken', user.username);

  if (refreshToken) {
    L.trace('Logging into Steam with refresh token');
    try {
      session.refreshToken = refreshToken;
      // session.renewRefreshToken() // This probably won't work, so we'll just let the refresh token expire
    } catch (err) {
      L.error({ err }, 'Error setting refresh token');
    }
  } else {
    let authCode: string | undefined;
    if (user.secret) {
      L.trace('Getting Steam Guard auth code');
      authCode = SteamTotp.getAuthCode(user.secret);
    }

    const waitForAuthentication = promiseTimeout(
      new Promise<void>((resolve) => {
        session.once('authenticated', () => {
          resolve();
        });
      }),
      { milliseconds: 30000, message: 'Timed out waiting for Steam authenticated' },
    );

    L.debug('Logging into Steam with password');
    await session.startWithCredentials({
      accountName: user.username,
      password: user.password,
      steamGuardCode: authCode,
    });
    await waitForAuthentication;
  }
  const cookies = await session.getWebCookies();
  L.debug('Steam login successful');
  await setStoreValue('refreshToken', user.username, session.refreshToken);
  return cookies;
};

export const loginSteamClient = async (user: LoginCredential): Promise<SteamUser> => {
  const L = logger.child({ username: user.username });
  L.debug('Logging user into steam client');
  const steamUser = new SteamUser();
  const refreshToken = await getStoreValue('refreshToken', user.username);

  const waitForAuthentication = promiseTimeout(
    new Promise<void>((resolve) => {
      steamUser.once('loggedOn', () => {
        resolve();
      });
    }),
    { milliseconds: 30000, message: 'Timed out waiting for Steam logged on' },
  );

  try {
    if (refreshToken) {
      L.trace('Logging into Steam with refresh token');

      steamUser.logOn({ refreshToken });
      // session.renewRefreshToken() // This probably won't work, so we'll just let the refresh token expire
      await waitForAuthentication;
    } else {
      L.trace('Getting Steam Guard auth code');
      let authCode: string | undefined;
      if (user.secret) {
        L.trace('Getting Steam Guard auth code');
        authCode = SteamTotp.getAuthCode(user.secret);
      }

      const waitForRefreshToken = promiseTimeout(
        new Promise<string>((resolve) => {
          steamUser.once('refreshToken' as never, (_refreshToken: string) => {
            resolve(_refreshToken);
          });
        }),
        { milliseconds: 30000, message: 'Timed out waiting for Steam refresh token' },
      );

      L.debug('Logging into Steam with password');
      steamUser.logOn({
        accountName: user.username,
        password: user.password,
        twoFactorCode: authCode,
      });
      await waitForAuthentication;
      const newRefreshToken = await waitForRefreshToken;
      await setStoreValue('refreshToken', user.username, newRefreshToken);
    }
    L.debug('Steam login successful');
    return steamUser;
  } catch (err) {
    // PATCH (login timeout): se o login expirou (30s) ou falhou, o steamUser
    // fica com a conexão aberta e segura o processo vivo — o run nunca morre
    // e o próximo tick do cron fica bloqueado (supercronic não inicia job novo
    // com o anterior rodando) até o timeout externo (RUN_TIMEOUT_SEC) matar.
    // logOff() fecha a conexão e deixa o processo sair; o erro é re-lançado
    // pro caller decidir o retry.
    L.warn({ err }, 'Steam login failed — closing connection');
    try {
      steamUser.logOff();
    } catch (logoffErr) {
      L.warn({ err: logoffErr }, 'Error logging off Steam client');
    }
    throw err;
  }
};
