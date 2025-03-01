/**
 * Set internalQueryFrameworkControl to tryBonsaiExperimental and
 * internalQueryCardinalityEstimatorMode to sampling. This is intended to be used by tasks which
 * should use experimental bonsai behavior, currently defined by both the control knob and the CE
 * mode, regardless of the configuration of the variant running the task. This is needed because the
 * suite definition cannot override a knob which is also defined by the variant.
 */
(function() {
'use strict';

if (typeof db !== "undefined") {
    assert.commandWorked(db.adminCommand({
        setParameter: 1,
        internalQueryFrameworkControl: "tryBonsaiExperimental",
        internalQueryCardinalityEstimatorMode: "sampling"
    }));
}

if (typeof TestData !== "undefined" && TestData.hasOwnProperty("setParameters") &&
    TestData.hasOwnProperty("setParametersMongos")) {
    TestData["setParameters"]["internalQueryFrameworkControl"] = "tryBonsaiExperimental";
    TestData["setParametersMongos"]["internalQueryFrameworkControl"] = "tryBonsaiExperimental";

    TestData["setParameters"]["internalQueryCardinalityEstimatorMode"] = "sampling";
    TestData["setParametersMongos"]["internalQueryCardinalityEstimatorMode"] = "sampling";
}
})();
