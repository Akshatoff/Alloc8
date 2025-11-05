from flask import Flask, request, jsonify

# 1. We import the solver logic from the other file
from optimization_logic import run_optimization

app = Flask(__name__)


@app.route("/generate-plan", methods=["POST"])
def generate_plan_endpoint():
    try:
        # 1. Get all the data from the frontend
        collected_data = request.json

        # 2. (This is the magic) Call your optimization function
        # This function is imported from optimization_logic.py
        plan_json = run_optimization(collected_data)

        # 3. Return the real plan to the frontend
        return jsonify(plan_json)

        # (The old placeholder code is now replaced)
        # print("Received data:", collected_data)
        # return jsonify({"message": "Data received, processing not yet implemented."})

    except Exception as e:
        # Return a specific error if optimization fails
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    app.run(debug=True, port=5000)
