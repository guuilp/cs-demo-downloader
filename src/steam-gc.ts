import GlobalOffensive from 'globaloffensive';
import PQueue from 'p-queue';
import { decodeMatchShareCode } from 'csgo-sharecode';
import promiseTimeout from 'p-timeout';
import { config, type AuthCodeUser } from './config.js';
import logger from './logger.js';
import { loginSteamClient } from './steam.js';
import { getAllNewMatchCodes } from './match-history.js';
import { getStoreValue, setStoreValue, getStoreArrayValue, setStoreArrayValue } from './store.js';
import { DownloadableMatch, downloadSaveDemo } from './download.js';
import { appendDemoLog } from './demo-log.js';

export interface MatchIdentifier {
  shareCode: string;
  matchId: bigint;
  steamId: string;
}

export interface MatchIdUrl {
  url: string;
  matchId: string;
}

type MatchRespFn = (match: GlobalOffensive.Match) => void;

export const getUserShareCodes = async (
  user: AuthCodeUser,
  shareCodesQueue: PQueue,
): Promise<MatchIdentifier[]> => {
  const { steamId64, authCode } = user;
  const L = logger.child({ steamId: steamId64 });
  try {
    // PATCH (cache de share codes): se já temos códigos cacheados deste
    // usuário (de um run anterior que não completou os downloads), usa-os
    // direto — evita re-fazer o API loop inteiro (centenas de calls) num
    // restart. O cache só é limpo quando um download é concluído (ver
    // getAllUsersMatches → setStoreValue('pendingShareCodes', ..., [])).
    const cachedCodes = await getStoreArrayValue('pendingShareCodes', steamId64);
    if (Array.isArray(cachedCodes) && cachedCodes.length > 0) {
      L.info({ count: cachedCodes.length }, 'Using cached share codes (skip API loop)');
      return cachedCodes.map((shareCode) => {
        const { matchId } = decodeMatchShareCode(shareCode);
        return { shareCode, steamId: steamId64, matchId };
      });
    }

    const storeShareCode = await getStoreValue('lastShareCode', steamId64);
    const lastShareCode = storeShareCode ?? user.oldestShareCode;
    if (!lastShareCode) throw new Error('No share code found');
    L.debug({ lastShareCode }, 'Getting new share codes');
    const shareCodes = await getAllNewMatchCodes(
      steamId64,
      authCode,
      lastShareCode,
      shareCodesQueue,
    );
    if (!storeShareCode) {
      shareCodes.unshift(lastShareCode);
    }
    // PATCH (cache): persiste os códigos fetados pra que um restart não
    // refaça o API loop inteiro. Só é limpo quando os downloads avançarem.
    if (shareCodes.length > 0) {
      await setStoreArrayValue('pendingShareCodes', steamId64, shareCodes);
      L.info({ count: shareCodes.length }, 'Cached share codes for next run');
    }
    return shareCodes.map((shareCode) => {
      const { matchId } = decodeMatchShareCode(shareCode);
      return { shareCode, steamId: steamId64, matchId };
    });
  } catch (err) {
    L.error({ err });
    return [];
  }
};

export const getAllUsersMatches = async (
  users: AuthCodeUser[],
  downloadQueue: PQueue,
): Promise<void> => {
  if (!config.authCodeLogin) throw new Error('Missing auth code login credentials');
  const L = logger.child({ username: config.authCodeLogin.username });
  const shareCodesQueue = new PQueue({ concurrency: 1, interval: 1500, intervalCap: 1 });
  const usersShareCodeIds = await Promise.all(
    users.map(async (user) => getUserShareCodes(user, shareCodesQueue)),
  );
  const shareCodes = Array.from(new Set(usersShareCodeIds.flat().map((id) => id.shareCode)));

  // Do nothing if no codes
  if (!shareCodes.length) {
    L.info('No new matches to download');
    return;
  }

  const steamUser = await loginSteamClient(config.authCodeLogin);
  steamUser.on('error', (err) => {
    L.error(err);
  });
  const waitForGame = promiseTimeout(
    new Promise<void>((resolve) => {
      steamUser.once('appLaunched', (id) => {
        if (id === 730) {
          resolve();
        }
      });
    }),
    { milliseconds: 30000, message: 'Timed out waiting for game to launch' },
  );
  steamUser.gamesPlayed(730, true);
  await waitForGame;
  const csgo = new GlobalOffensive(steamUser);

  // robust match response promise handler
  const pendingMatchResponses = new Map<string, MatchRespFn>();
  csgo.on('matchList', (matches) => {
    L.trace({ matchesLength: matches.length }, 'Recieved matchList event');
    matches.forEach((match) => {
      const cb = pendingMatchResponses.get(match.matchid);
      if (cb) {
        L.debug({ matchId: match.matchid }, 'Resolving match request');
        pendingMatchResponses.delete(match.matchid);
        cb(match);
      }
    });
  });

  L.info({ shareCodes }, 'Requesting metadata from game coordinator');
  const requestGameQueue = new PQueue({ concurrency: 1 });
  const matchFetchResults = await Promise.all(
    shareCodes.map((shareCode) =>
      requestGameQueue.add(
        async () => {
          try {
            const { matchId } = decodeMatchShareCode(shareCode);
            L.debug({ matchId, shareCode }, 'Requesting game data');
            const [match] = await Promise.all([
              promiseTimeout(
                new Promise<GlobalOffensive.Match>((resolve) => {
                  pendingMatchResponses.set(matchId.toString(), resolve);
                }),
                {
                  milliseconds: 30000,
                  message: `Error fetching match data for match ${shareCode}`,
                },
              ),
              csgo.requestGame(shareCode),
            ]);
            return match;
          } catch (err) {
            L.error({ err, shareCode });
            return undefined;
          }
        },
        { throwOnTimeout: true },
      ),
    ),
  );
  const resolvedMatches = matchFetchResults.filter(
    (match): match is GlobalOffensive.Match => match !== undefined,
  );

  // Quit CS
  const waitForQuit = promiseTimeout(
    new Promise<void>((resolve) => {
      steamUser.once('appQuit', (id) => {
        if (id === 730) {
          resolve();
        }
      });
    }),
    { milliseconds: 30000, message: 'Timed out waiting for game to quit' },
  );
  steamUser.gamesPlayed([], true);
  await waitForQuit;
  steamUser.logOff();

  L.info({ resolvedMatchesCount: resolvedMatches.length }, 'Downloading new matches');

  // Convert demo download metadata
  const dlMatches: DownloadableMatch[] = resolvedMatches.map((match) => {
    const playerCount = match.roundstatsall[0]?.reservation.account_ids.filter((id) => id !== 0)
      .length;
    const isWingman = playerCount && playerCount <= 4;
    const isPremier = match.roundstatsall[0]?.b_switched_teams; // null for comp, true for premier
    let type: string;
    if (isWingman) {
      type = 'wingman';
    } else if (isPremier) {
      type = 'premier';
    } else {
      type = 'competitive';
    }
    return {
      matchId: BigInt(match.matchid),
      url: match.roundstatsall.at(-1)?.map as string | undefined,
      date: new Date((match.matchtime as number) * 1000),
      type,
    };
  });

  // PATCH (checkpoint por usuário): dlMatches é deduplicado entre usuários
  // (demo compartilhada baixada 1x). Para não perder progresso se o processo
  // quebrar no meio dos downloads (que levam horas), mapeamos cada matchId aos
  // jogadores donos e gravamos o lastShareCode de cada usuário ASSIM QUE todos
  // os demos dele forem tentados — em vez de só no fim de tudo.
  const matchOwners = new Map<string, Set<string>>(); // matchId -> steamIds
  const userLastResolved = new Map<string, MatchIdentifier>(); // steamId -> último processado
  const userPending = new Map<string, number>(); // steamId -> demos restantes

  usersShareCodeIds.forEach((userShareCodeIds) => {
    let lastProcessed: MatchIdentifier | undefined;
    userShareCodeIds.forEach((matchIdentifier) => {
      if (resolvedMatches.some((match) => match.matchid === matchIdentifier.matchId.toString())) {
        lastProcessed = matchIdentifier;
        const key = matchIdentifier.matchId.toString();
        if (!matchOwners.has(key)) {
          matchOwners.set(key, new Set());
        }
        matchOwners.get(key)?.add(matchIdentifier.steamId);
        userPending.set(
          matchIdentifier.steamId,
          (userPending.get(matchIdentifier.steamId) || 0) + 1,
        );
      }
    });
    if (lastProcessed) {
      userLastResolved.set(lastProcessed.steamId, lastProcessed);
    }
  });

  // Download the demos. Após cada download, faz checkpoint dos usuários donos
  // cujo pending zera — escreve lastShareCode + esvazia cache na hora.
  await appendDemoLog(dlMatches);
  await Promise.all(
    dlMatches.map((match) =>
      downloadQueue.add(
        async () => {
          await downloadSaveDemo(match);
          const owners = matchOwners.get(match.matchId.toString());
          if (!owners) {
            return;
          }
          owners.forEach(async (steamId) => {
            const remaining = (userPending.get(steamId) || 1) - 1;
            userPending.set(steamId, remaining);
            if (remaining <= 0) {
              const last = userLastResolved.get(steamId);
              if (last) {
                await setStoreValue('lastShareCode', last.steamId, last.shareCode);
                await setStoreArrayValue('pendingShareCodes', last.steamId, []);
                logger.info(
                  { steamId, shareCode: last.shareCode },
                  'Checkpoint: lastShareCode saved for user',
                );
              }
            }
          });
        },
        { throwOnTimeout: true },
      ),
    ),
  );
};
