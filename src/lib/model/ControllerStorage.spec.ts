import { Accessory } from "../Accessory";
import { ControllerIdentifier, ControllerServiceMap, SerializableController, StateChangeDelegate } from "../controller";
import * as uuid from "../util/uuid";
import { ControllerStorage } from "./ControllerStorage";

interface State {
  first?: string;
  second?: string;
}

// restores its state in two steps and reports a state change in between, like a controller whose
// characteristic updates during deserialize trigger its own change listeners
class SteppedController implements SerializableController<ControllerServiceMap, State> {
  state: State = {};
  private stateChangeDelegate?: StateChangeDelegate;

  controllerId(): ControllerIdentifier {
    return "stepped";
  }

  constructServices(): ControllerServiceMap {
    return {};
  }

  initWithServices(): void | ControllerServiceMap {
    return undefined;
  }

  configureServices(): void {
    // nothing to configure
  }

  handleControllerRemoved(): void {
    // nothing to clean up
  }

  serialize(): State | undefined {
    return { ...this.state };
  }

  deserialize(serialized: State): void {
    this.state.first = serialized.first;
    this.stateChangeDelegate?.();
    this.state.second = serialized.second;
  }

  setupStateChangeDelegate(delegate?: StateChangeDelegate): void {
    this.stateChangeDelegate = delegate;
  }

  handleFactoryReset(): void {
    this.state = {};
  }
}

describe("ControllerStorage", () => {
  test("state changes reported while restoring do not overwrite the stored data", () => {
    const accessory = new Accessory("Test", uuid.generate("controller-storage"));
    const storage = new ControllerStorage(accessory);
    const controller = new SteppedController();
    storage.trackController(controller);

    // @ts-expect-error: private access
    storage.init([{ type: "stepped", controllerData: { data: { first: "a", second: "b" } } }]);

    expect(controller.state).toEqual({ first: "a", second: "b" });
    // @ts-expect-error: private access
    expect(storage.controllerData.stepped.data).toEqual({ first: "a", second: "b" });

    controller.state.second = "c";
    // @ts-expect-error: private access
    storage.handleStateChange(controller);
    // @ts-expect-error: private access
    expect(storage.controllerData.stepped.data).toEqual({ first: "a", second: "c" });
    // @ts-expect-error: private access
    clearTimeout(storage.queuedSaveTimeout);
  });
});
