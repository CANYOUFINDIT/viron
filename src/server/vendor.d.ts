declare module "bcrypt-pbkdf" {
  export function hash(passwordSha512: Uint8Array, saltSha512: Uint8Array, output: Uint8Array): void;
  export function pbkdf(
    password: Uint8Array,
    passwordLength: number,
    salt: Uint8Array,
    saltLength: number,
    key: Uint8Array,
    keyLength: number,
    rounds: number,
  ): number;
}
