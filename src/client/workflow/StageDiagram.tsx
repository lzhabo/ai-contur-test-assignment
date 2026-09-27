import type { ReactElement } from "react";
import type { TaskSnapshotResponse } from "../../shared/api";
import { STATUS_LABELS, type StageId, type WorkflowView } from "./model";

/** Рисует этапы и возвраты ревьюера; выбор этапа передаёт владельцу фильтра. */
export function StageDiagram({
  snapshot,
  view,
  selection,
  selectStage,
}: {
  snapshot: TaskSnapshotResponse;
  view: WorkflowView;
  selection: StageId | "all";
  selectStage: (stage: StageId) => void;
}): ReactElement {
  return (
    <div className="workflow-scroll">
      <div className="workflow-diagram">
        <svg
          className="workflow-lines"
          viewBox="0 0 960 180"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <marker
              id="workflow-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {[0, 1, 2, 3, 4].map((index) => (
            // Соединяет соседние этапы стрелкой.
            <path
              key={index}
              d={`M ${index * 160 + 148} 61 H ${index * 160 + 168}`}
              markerEnd="url(#workflow-arrow)"
            />
          ))}
          <path
            className={view.returns.length ? "return-edge used" : "return-edge"}
            d="M 400 116 V 150 H 80 V 116"
            markerEnd="url(#workflow-arrow)"
          />
          <text x="240" y="175" textAnchor="middle">
            Ревьюер → автор:{" "}
            {view.returns.length ? `возвратов ${view.returns.length}` : "возвратов пока нет"}
          </text>
        </svg>
        <div className="workflow-nodes">
          {view.stages.map((stage) => (
            // Отображает фактический статус этапа и его исполнителя.
            <button
              key={stage.id}
              aria-pressed={selection === stage.id}
              className={`workflow-node ${stage.status} ${selection === stage.id ? "selected" : ""}`}
              onClick={() => {
                // Показывает события выбранного этапа.
                selectStage(stage.id);
              }}
            >
              <strong>{stage.title}</strong>
              <span>
                {stage.id === "author" || stage.id === "reviewer" || stage.id === "applier"
                  ? snapshot.state.models[stage.id]
                  : stage.detail}
              </span>
              <small>{STATUS_LABELS[stage.status]}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
