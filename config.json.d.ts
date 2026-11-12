// Type information for the optional runtime JSON file. This declaration does
// not create, load, or validate config.json; deployment still requires its own
// configuration according to the relevant service's runtime policy.
declare const config: {
    dashboard?: {
        delegatedAccessEnabled?: boolean;
        delegatedAccessRolloutStartAt?: string;
        delegatedAccessRolloutDurationHours?: number | string;
    };
    mediaDelivery?: unknown;
    autoWatch?: unknown;
    auto_watch?: unknown;
};
export = config;
