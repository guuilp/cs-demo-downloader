import axios from 'axios';
import bz2 from 'unbzip2-stream';
import fs from 'node:fs';
import fsp from 'fs/promises';
import fsx from 'fs-extra';
import util from 'node:util';
import stream from 'node:stream';
import path from 'node:path';
import L from './logger.js';

export interface DownloadableMatch {
  date: Date;
  url?: string;
  matchId: bigint;
  type?: string;
}

const pipeline = util.promisify(stream.pipeline);
const demosDir = process.env['DEMOS_DIR'] || 'demos';
const tempDemosDir = path.join(demosDir, 'temp');

export const gcpdUrlToFilename = (url: string, suffix?: string): string => {
  // http://replay129.valve.net/730/003638895521671676017_1102521424.dem.bz2
  // match730_003617919461891244205_1406239579_129.dem

  const matchGroups = url.match(/^https?:\/\/replay(\d+)\.valve\.net\/(\d+)\/(\d+_\d+)\.dem\.bz2$/);
  if (!matchGroups) throw new Error(`Invalid GCPD URL: ${url}`);
  const [, regionId, gameId, matchId] = matchGroups;
  return `match${gameId}_${matchId}_${regionId}${suffix ? `_${suffix}` : ''}.dem`;
};

/**
 * Downloads, extracts, and updates modified date of demo
 * @param match Match metadata
 * @returns matchId if match failed
 */
export const downloadSaveDemo = async (match: DownloadableMatch): Promise<bigint | null> => {
  // PATCH (throttle CDN): retry com backoff exponencial. O CDN da Valve
  // throttla com ETIMEDOUT quando recebe muitos requests em rajada; com
  // timeout de 120s + retries espaçados, um download falho tem 2ª/3ª chance.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (!match.url) throw new Error('Match download URL missing');

      await fsx.mkdirp(tempDemosDir);
      const tempFilename = path.join(tempDemosDir, gcpdUrlToFilename(match.url, match.type));

      await fsx.mkdirp(demosDir); // redundant, but added in-case the temp directory is changed in the future to not be nested within the demos directory
      const completedFilename = path.join(demosDir, gcpdUrlToFilename(match.url, match.type));

      const exists = await fsx.exists(completedFilename);
      if (!exists) {
        L.trace({ url: match.url, attempt }, 'Downloading demo');
        const resp = await axios.get<stream.Duplex>(match.url, {
          responseType: 'stream',
          timeout: 120000, // PATCH: antes não tinha timeout (default 0 = infinito)
          maxRedirects: 5,
          family: 4, // PATCH: força IPv4 — a VPN não tem IPv6 e o Happy Eyeballs
          // do Node/axios tenta IPv6 primeiro (ENETUNREACH) e o connect IPv4
          // acaba dando timeout na seleção. wget baixa OK; axios falhava.
        });
        L.trace({ url: match.url }, 'Demo download complete');
        await pipeline(resp.data, bz2(), fs.createWriteStream(tempFilename, 'binary'));
        L.trace({ filename: tempFilename }, 'Demo saved to file');
        await fsp.rename(tempFilename, completedFilename);
        await fsp.utimes(completedFilename, match.date, match.date);
        L.info({ filename: completedFilename, date: match.date }, 'Demo save complete');
      } else {
        L.info({ filename: completedFilename }, 'File already exists, skipping download');
      }
      return null;
    } catch (err) {
      // PATCH (502/permanentes): só re-tenta erros de REDE (sem resposta HTTP:
      // ETIMEDOUT, ECONN*, ENETUNREACH, etc.). Erros HTTP permanentes
      // (ex: 502 — demo expirada do replay server da Valve) NÃO são
      // retryáveis: o servidor respondeu e o resultado não muda. Retryar
      // 502 só fazia o downloader gastar ~15s/demo em demos mortas do backfill.
      const hasHttpResponse = (err as { response?: unknown }).response !== undefined;
      if (hasHttpResponse || attempt >= MAX_ATTEMPTS) {
        L.error(
          { err, match },
          `Error downloading GCPD demo (attempt ${attempt}/${MAX_ATTEMPTS}, retryable=${!hasHttpResponse})`,
        );
        return match.matchId;
      }
      const delayMs = 5000 * attempt;
      L.warn({ err, match, attempt, delayMs }, `Network error, retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null; // unreachable, satisfies TS control flow
};
