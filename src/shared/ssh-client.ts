import { Client, type ConnectConfig, type KeyboardInteractiveCallback, type Prompt } from "ssh2";

export function connectSshClient(client: Client, config: ConnectConfig, keyboardInteractivePassword?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const answerKeyboardChallenge = (
      _name: string,
      _instructions: string,
      _language: string,
      prompts: Prompt[],
      finish: KeyboardInteractiveCallback,
    ) => {
      finish(prompts.map(() => keyboardInteractivePassword ?? ""));
    };
    if (keyboardInteractivePassword !== undefined) client.on("keyboard-interactive", answerKeyboardChallenge);
    const releaseCredentialListener = () => client.removeListener("keyboard-interactive", answerKeyboardChallenge);

    client.once("ready", () => {
      if (settled) return;
      settled = true;
      releaseCredentialListener();
      resolve(client);
    });
    client.on("error", (error) => {
      if (settled) return;
      settled = true;
      releaseCredentialListener();
      reject(error);
    });

    try {
      client.connect(config);
    } catch (error) {
      if (settled) return;
      settled = true;
      releaseCredentialListener();
      reject(error);
    }
  });
}
