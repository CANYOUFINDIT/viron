import { describe, expect, it } from "vitest";
import { parseOrganizationInvitationToken } from "../src/client/organization-invitation";

const token = "VJd_MyGXnGQ18hxUi_FdDHMW-_H_33W4a8HDdMO0l2o";

describe("parseOrganizationInvitationToken", () => {
  it("extracts a token from a Web invitation link", () => {
    expect(parseOrganizationInvitationToken(` https://viron.example.test/join/${token} `)).toBe(token);
  });

  it("accepts a desktop hash route", () => {
    expect(parseOrganizationInvitationToken(`file:///Applications/Viron.app/index.html#/join/${token}`)).toBe(token);
  });

  it("ignores query strings and hash route query parameters", () => {
    expect(parseOrganizationInvitationToken(`https://viron.example.test/join/${token}?source=chat`)).toBe(token);
    expect(parseOrganizationInvitationToken(`https://viron.example.test/#/join/${token}?source=app`)).toBe(token);
  });

  it("rejects unrelated, incomplete, and malformed links", () => {
    expect(parseOrganizationInvitationToken("https://viron.example.test/organization")).toBeNull();
    expect(parseOrganizationInvitationToken("https://viron.example.test/join/")).toBeNull();
    expect(parseOrganizationInvitationToken("not-a-link")).toBeNull();
  });
});
