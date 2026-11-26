// Registers every built-in operator. Import once at startup.
import { register } from '../registry';
import { ops as core } from './core';
import { ops as generate } from './generate';
import { ops as signal } from './signal';
import { ops as distort } from './distort';
import { ops as color } from './color';
import { ops as stylize } from './stylize';
import { ops as media } from './media';
import { ops as signature } from './signature';
import { ops as light } from './light';
import { ops as space } from './space';
import { ops as stage } from './stage';
import { ops as vision } from './vision';
import { ops as sim } from './sim';
import { ops as subject } from './subject';
import { ops as graphics } from './graphics';
import { ops as mesh } from './mesh';
import { ops as particles } from './particles';
import { ops as spectral } from './spectral';

let done = false;
export function registerAll() {
  if (done) return;
  done = true;
  register([...core, ...generate, ...signal, ...distort, ...color, ...stylize, ...media, ...signature, ...light, ...space, ...stage, ...vision, ...sim, ...subject, ...graphics, ...mesh, ...particles, ...spectral]);
}
