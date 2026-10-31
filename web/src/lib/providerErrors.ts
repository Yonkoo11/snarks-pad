// The two ways a data provider fails the page: it limits this browser (try later), or it does not answer. Kept apart from the readers so a test can import them.
export class ProviderLimited extends Error {}
export class ProviderDown extends Error {}
